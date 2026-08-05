/**
 * Desktop 端 anthropic-compat-proxy 生命周期管理 ——
 *
 * 负责在 splash 阶段(getMaker() 之前)启动一个本地 loopback 代理,把
 * Claude Code 子进程的 ANTHROPIC_BASE_URL 指向这个代理。代理在转发到真上游
 * 前会:
 *   - Claude 自家模型(claude-*)请求字节透传,延迟 0
 *   - 非 Claude 模型(gpt-5.4 / kimi / glm 等)的请求,strip Anthropic-only
 *     字段(output_config / thinking / cache_control / betas),避免 litellm
 *     转发到 Azure backend 时返回 "Unknown parameter" 400
 *
 * 失败兜底: 代理起不来时(端口冲突 / OS 异常),fallback 直接返回真上游 URL
 * +打 ERROR 日志。Claude Code 仍能跑(只是非 Anthropic 模型会报 400),不阻塞
 * 整个 app 启动。
 *
 * dispose: 由 bootstrap-electron.ts 的 onQuit 注册器在退出阶段调用。
 */

import {
  createAnthropicCompatProxy,
  createActiveStripTransform,
  createDuplicateToolUseIdRecoveryRule,
  createEmptyAssistantMessageRecoveryRule,
  createEmptyTextRecoveryRule,
  createEmptyThinkingRecoveryRule,
  createEncryptedContentRecoveryRule,
  createToolExchangeAdjacencyRecoveryRule,
  createToolUseProviderSpecificFieldsRecoveryRule,
  dedupeDuplicateToolUseIds,
  isFetchBlockedPort,
  repairToolExchangeAdjacency,
  stripEmptyAssistantMessagesFromBody,
  stripEmptyTextFromBody,
  stripEmptyThinkingFromBody,
  stripEncryptedContentFromBody,
  stripNonAnthropicFields,
  stripToolUseProviderSpecificFields,
  type ProxyHandle,
  type RequestTransform,
  type RoutingDecision,
  type RoutingTransform,
} from '@cindy/anthropic-compat-proxy';

import { ANTHROPIC_DIRECT_UPSTREAM, CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY, anthropicCatalogModelIds, isAnthropicWireModel } from './claude-gateway-config.js';
import { getActiveCatalog } from './active-catalog.js';
import { getResponsesBridgeHandler } from './anthropic-responses-bridge-host.js';
import { getSessionEffort, getSessionFastMode } from './session-effort-store.js';
import { isSubscriptionDirectModel } from '../../shared/subscriptionModels.js';
import {
  composeResponseObservers,
  createClaudeRateLimitHeadersObserver,
} from './claude-rate-limit-headers-observer.js';
import {
  noteClaudeSessionRequest,
  recordClaudeRequestRoute,
  recordClaudeSessionRoute,
  type ClaudeSessionBillingRoute,
} from './claude-session-route-registry.js';
import { createClaudeGatewayErrorObserver } from './claude-gateway-error-observer.js';
import { getSessionProvider } from './session-provider-store.js';
import {
  gatewayDefaultRouteDecision,
  getUserProviderIdForSession,
  listExternalRoutableProviders,
  resolveExternalModelRouteDecision,
  resolveSessionRouteDecision,
  rewriteImplicitModelIdForRoute,
} from './provider-route.js';
import {
  isCindyLocalToken,
  isExternalAccessEnabled,
  matchesExternalToken,
} from './local-proxy-external-auth.js';
import {
  loadLocalProxySettings,
  setLocalProxyPort,
} from './local-proxy-settings-store.js';
import { createProviderUpstreamErrorObserver } from './provider-upstream-error-observer.js';
import { createClaudeAutoClassifierFailureObserver } from './claude-auto-permission-fallback.js';
import {
  emptyAssistantStripController,
  emptyTextStripController,
  emptyThinkingStripController,
  encryptedStripController,
} from './thread-strip-controllers.js';
import { createMakerLogger } from './logger-adapter.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
import {
  createClaudeFastModeRequestTransform,
  createClaudeFastModeResponseObserver,
} from './claude-fast-mode-log.js';
import {
  createClaudeSubagentUsageRequestTransform,
  createClaudeSubagentUsageResponseObserver,
} from './claude-subagent-usage-bridge.js';
import { claudeUpstreamEndpoint } from './runtime-configs.js';
import { readSilentEncryptedRetrySettings } from './silent-encrypted-retry-store.js';
import {
  createClaudeSessionActivityResponseObserver,
  recordClaudeApiActivity,
} from './claude-session-background-activity.js';
import { authenticatePiProxySession } from './pi-proxy-session-auth.js';

// scope = 'cc-proxy' → logger.ts 的 emit() 路由把这条流量并入统一 agent 流
// (agent-*.ndjson, source=proxy)。child(sub) 会继续保持 'cc-proxy/sub' 前缀, routing 一致。
const log = createMakerLogger('cc-proxy');

let _handle: ProxyHandle | null = null;
let _initialized = false;

// gateway api key reader —— 由 host 注入(readClaudeApiKey),避免 proxy-host 直接 import
// auth-adapters(重模块)。oauth-spawn 下走网关的请求(默认 / 选 XD)要把鉴权头换成它。
// 复刻 codex-proxy-host.ts 的 setCodexProxyGatewayKeyReader 套路。
let _readGatewayKey: () => string | null = () => null;
export function setClaudeProxyGatewayKeyReader(fn: () => string | null): void {
  _readGatewayKey = fn;
}

// cc 是否处于 oauth-spawn —— 由 host 注入(hasClaudeAiOAuth)。退役全局 authMode 后,cc 的 spawn
// 凭证形态完全由「是否连了 Claude.ai 订阅」决定(见 auth-adapters.getAuthEnv):连了 = oauth-spawn
// (带 OAuth bearer,默认须换网关 key),否则 = gateway-spawn(自带网关 key,默认 passthrough)。
// 默认 false:未注入时按 gateway-spawn 处理(passthrough),与未连订阅用户字节级一致。
let _isOAuthSpawn: () => boolean = () => false;
export function setClaudeProxyOAuthSpawnChecker(fn: () => boolean): void {
  _isOAuthSpawn = fn;
}

// per-session 供应商路由 resolver —— 由 host(register.ts)用 maker.listActiveSessions() 把
// x-claude-code-session-id(= cc sdkSessionId)反解成 xdt sessionId 提供。返回 null = 该
// sdkSessionId 当前无对应活跃会话。routingTransform 据此查该会话显式选定的供应商做统一路由;
// 未注入 / 查不到 / 该会话没选供应商 → 回落 spawn-aware 默认路由(与未升级行为字节级一致)。
let _resolveCcSessionId: ((sdkSessionId: string) => string | null) | null = null;
export function setClaudeProxySessionIdResolver(
  fn: (sdkSessionId: string) => string | null,
): void {
  _resolveCcSessionId = fn;
}

// 订阅直连的 model 前缀判据(chatgpt/ / xai/)统一走 shared/subscriptionModels 的
// isSubscriptionDirectModel —— 路由(此处把这些前缀路由到 bridge)与 turn-cost 记账 gate
// 必须同源,否则漂移 = 路由当订阅直连、记账当真实计费(计费错算)。

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 大小写不敏感取 header 值;缺失或空串 → null。 */
function headerValue(headers: Readonly<Record<string, string>>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// ───────────────────────── 对外模型代理(external client)─────────────────────────
// 用户自己电脑上的 Claude Code CLI 把 ANTHROPIC_BASE_URL 指向本代理、ANTHROPIC_API_KEY
// 设为 Cindy 生成的对外 token 时,这些请求没有 Cindy session。它们靠 x-api-key 命中已存
// 对外 token 被识别为「外部客户端」,走一条独立、无会话、按模型名/默认供应商的路由分支,
// **绝不回落 Cindy 默认网关/订阅路由**(否则外部 token 会被当成 gateway 的 x-api-key 透传
// 上游 → 凭证泄漏/误计费)。

/** 从 ctx.url(可能带 query)取纯 path,小写化便于匹配。 */
function requestPathname(url: string): string {
  const q = url.indexOf('?');
  return (q === -1 ? url : url.slice(0, q)).toLowerCase();
}

/** 外部分支的统一 JSON 错误响应(localHandler 完全接管,不转发上游)。 */
function externalErrorDecision(
  status: number,
  code: string,
  message: string,
): RoutingDecision {
  return {
    localHandler: async ({ res }) => {
      const payload = JSON.stringify({
        type: 'error',
        error: { type: status === 401 || status === 403 ? 'authentication_error' : 'invalid_request_error', code, message },
      });
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(payload);
    },
  };
}

/**
 * 转发前从外部请求剥掉它自带的对外 token 头,防止透传上游。
 * headerDelete 在 headerOverride **之后**应用 —— 若路由决策已用 headerOverride 覆盖了某个
 * 鉴权头(gateway-key / api-key-header 注入真实凭证),就**不能**再 delete 它(否则会净删除真凭证);
 * 仅对决策没有覆盖的鉴权头追加 delete。这样:注入了真凭证的头保留真值,没注入的(如 oauth-passthrough
 * 只 upstreamOverride 不换头)则把外部 token 删掉 → fail-closed(上游 401),不泄漏。
 */
function stripExternalTokenHeaders(decision: RoutingDecision | null): RoutingDecision | null {
  if (!decision || decision.localHandler) return decision;
  const overridden = new Set(
    Object.keys(decision.headerOverride ?? {}).map((k) => k.toLowerCase()),
  );
  const toDelete = ['x-api-key', 'authorization'].filter((h) => !overridden.has(h));
  if (toDelete.length === 0) return decision;
  return {
    ...decision,
    headerDelete: [...new Set([...(decision.headerDelete ?? []), ...toDelete])],
  };
}

/**
 * 构造 `GET /v1/models` 的 Anthropic 形状清单:外部 CLI 用它发现可用模型。
 * 取「对外可路由的 claude-code 供应商」并集里的模型,按 id 去重(同一 stock claude-* 可能
 * 同时由多家提供)。不含任何凭证 / 上游地址。
 *
 * 只宣告 `listExternalRoutableProviders('claude-code')` 认可的供应商:与实际路由判据
 * (`isExternalRoutableProvider`,排除 oauth-passthrough 订阅直连、网关不可用的 xd 等)同源。
 * 否则会把外部客户端根本路由不通的模型也列进 discovery,诱导其选中后必然上游 401。
 */
function buildExternalModelsPayload(): string {
  const routableIds = new Set(
    listExternalRoutableProviders('claude-code').map((provider) => provider.id),
  );
  const seen = new Set<string>();
  const data: { type: 'model'; id: string; display_name: string }[] = [];
  for (const provider of getActiveCatalog().providers) {
    if (!routableIds.has(provider.id)) continue;
    for (const model of provider.models['claude-code'] ?? []) {
      if (!model.id || seen.has(model.id)) continue;
      seen.add(model.id);
      data.push({ type: 'model', id: model.id, display_name: model.name });
    }
  }
  return JSON.stringify({
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  });
}

/**
 * 外部客户端请求的路由决策。**先判 enabled**:未开启 → 401(即使 token 还在,也拒绝,
 * 防止关了开关后旧 token 还能用)。GET /v1/models → 本地吐清单。其余按 model 解析供应商,
 * 解析不出 → 400(不回落默认路由)。最后 strip 外部 token 头。
 */
function routeExternalClient(
  body: unknown,
  ctx: Parameters<RoutingTransform>[1],
): RoutingDecision | Promise<RoutingDecision | null> {
  if (!isExternalAccessEnabled()) {
    return externalErrorDecision(401, 'external_access_disabled', 'Cindy 对外模型代理未开启。');
  }
  const pathname = requestPathname(ctx.url);
  if (ctx.method.toUpperCase() === 'GET' && /\/v1\/models\/?$/.test(pathname)) {
    return {
      localHandler: async ({ res }) => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(buildExternalModelsPayload());
      },
    };
  }
  if (!isPlainObject(body)) {
    // 非 JSON 的外部请求(非 /models 的控制面调用等):不识别就拒绝,绝不带着 token 透传上游。
    return externalErrorDecision(400, 'unsupported_request', '不支持的外部请求。');
  }
  const wireModel = typeof body.model === 'string' ? body.model : '';
  // 订阅前缀模型(chatgpt/ / xai/):交本地 responses bridge,用 Cindy 持有的订阅 OAuth 直连
  // (与内部同一 handler)。外部客户端由此可复用 Cindy 的订阅额度。
  if (isSubscriptionDirectModel(wireModel)) {
    const bridgeHandler = getResponsesBridgeHandler();
    if (!bridgeHandler) {
      return externalErrorDecision(503, 'bridge_unavailable', '订阅直连桥暂不可用。');
    }
    return { localHandler: (args) => bridgeHandler.handle({ ...args, prefs: {} }) };
  }
  const gatewayKey = _readGatewayKey();
  const defaultProviderId = loadLocalProxySettings().defaultProviderId;
  return resolveExternalModelRouteDecision(wireModel, gatewayKey, defaultProviderId).then(
    (decision) => {
      if (!decision) {
        return externalErrorDecision(
          400,
          'no_provider_for_model',
          `没有可路由「${wireModel || '(未指定)'}」的供应商;请在 Cindy 设置里选择对外默认供应商,或换用某供应商的模型 id。`,
        );
      }
      return stripExternalTokenHeaders(decision);
    },
  );
}

/**
 * 外部模型代理的 model id 改写请求 transform:仅对外部客户端(x-api-key 命中对外 token)
 * 生效,把带命名空间前缀的 model(如某自定义供应商的 `foo/bar`)在发往上游前剥成上游可识别
 * 的裸 id。与路由 transform 同源(都用 inferProviderIdForModel);路由 transform 看**原始** body
 * (带前缀)推断供应商,本 transform 改写**转发** body,两者互补。
 */
function createExternalModelRewriteTransform(): RequestTransform {
  return (body, ctx) => {
    if (!matchesExternalToken(headerValue(ctx.headers, 'x-api-key'))) return null;
    return rewriteImplicitModelIdForRoute('claude-code', body);
  };
}

/**
 * per-request 路由 transform。两段:
 *   ① 会话显式选了供应商 → 据 catalog 统一路由(per-session,取代全局开关推断)。
 *   ② 未显式选 → 据**请求实际携带的凭证**判定 spawn 形态:
 *      - 带 x-api-key(= gateway-spawn,cc 自带网关 key)→ passthrough,字节级不变。
 *      - 不带 x-api-key(= oauth-spawn,cc 带订阅 OAuth bearer)→ 默认全量换网关 key
 *        (覆盖 bearer + 删 anthropic-beta,防订阅 token 泄漏到网关);要走订阅须 per-session 选 Anthropic。
 *   **为什么看请求头而非 hasClaudeAiOAuth() live 读**:cc 进程的凭证在 spawn 时冻结,而 OAuth 连接态
 *   可能在会话中途变化(用户在供应商页连/断);live 读(还会每请求 shell-out 读 keychain,慢且与并发的
 *   keychain 写竞争)会与 cc 实际持有的凭证发散,导致 OAuth bearer 被误判 passthrough 泄漏到网关 → 401。
 *   请求头反映的就是 cc 此刻真正握着的凭证,稳健且零 syscall(规则 10 热路径)。
 *
 * ② 段的每个决策点旁路记录 sessionId → 生效计费路由(claude-session-route-registry),
 * 供 renderer 的用量 chip 按**会话实际流量**显示计费形态 —— 同样因为 spawn 凭证冻结,
 * chip 用全局活性状态重算会与 child 真实路由发散。export 仅供单测。
 */
export function createModelRoutingTransform(): RoutingTransform {
  const route: RoutingTransform = (body, ctx) => {
    // ⓪ 对外模型代理:x-api-key 命中已存对外 token → 外部客户端,走独立无会话分支。
    //    放在最前:优先级高于 Pi / per-session / spawn 默认路由。命中判定与 enabled 无关
    //    (matchesExternalToken 只比 token),enabled 与否在 routeExternalClient 内决定放行/401。
    //    未命中(Cindy 自家子进程 / 无 token)→ 落到下方现有逻辑,字节级不变。
    const externalApiKey = headerValue(ctx.headers, 'x-api-key');
    if (matchesExternalToken(externalApiKey)) {
      return routeExternalClient(body, ctx);
    }
    // 带 `cindy-local-` 前缀但不命中 A 族 token(已重置 / 跨族拿 B 族 token 打 A 族 loopback /
    // 已失效)→ 明确 401,绝不落到下方内部路由把这个对外 token 当 x-api-key 透传上游。
    if (isCindyLocalToken(externalApiKey)) {
      return externalErrorDecision(401, 'invalid_external_token', 'Cindy 对外访问 token 无效或已失效。');
    }
    const claimedPiSessionId = headerValue(ctx.headers, 'x-cindy-pi-session-id');
    if (
      claimedPiSessionId
      && !authenticatePiProxySession(
        claimedPiSessionId,
        headerValue(ctx.headers, 'x-cindy-pi-session-token'),
      )
    ) {
      // Loopback is not an authentication boundary: another local process can
      // forge a business session id. Reject before provider routing so it can
      // never borrow that session's OAuth token or gateway key.
      return {
        localHandler: async ({ res }) => {
          const payload = JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              code: 'invalid_pi_session_token',
              message: 'Invalid or expired Pi proxy session token.',
            },
          });
          res.writeHead(401, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(payload);
        },
      };
    }
    const piSessionId = claimedPiSessionId;
    const requestAgent = piSessionId ? 'pi' : 'claude-code';
    // 后台活动检测(claude-session-background-activity):凡带 cc 会话标头的请求
    // 都记一笔活动时刻。routingTransform 会处理无 body 控制面请求与 JSON 请求；
    // 非 JSON 的 POST/PUT/PATCH 不经过这里,由响应侧 observer 兜底观察活动。
    // 开销 = 一次 header 读 + 一次活跃会话表反解 + Map.set,非 per-token 路径。
    const sdkSessionId = ctx.headers['x-claude-code-session-id'];
    const ccSessionId = sdkSessionId && _resolveCcSessionId
      ? _resolveCcSessionId(sdkSessionId)
      : null;
    const sessionId = piSessionId ?? ccSessionId;
    if (sdkSessionId) {
      recordClaudeApiActivity(
        sdkSessionId,
        ccSessionId,
      );
    }
    if (ccSessionId) noteClaudeSessionRequest(ccSessionId, ctx.reqId);
    if (!isPlainObject(body)) return null;
    const wireModel = typeof body.model === 'string' ? body.model : '';

    // ⓪ 订阅直连翻译:model 带 `chatgpt/` / `xai/` 前缀 → 交给本地 responses handler
    //    (localHandler 插槽,进程内直调,不多一跳;它把 Anthropic Messages ↔ OpenAI Responses
    //    双向翻译,用对应订阅 OAuth 直打 codex / api.x.ai)。
    //    per-request(看 body.model,不看 session)—— 这样 Claude 主会话的 sub-agent 只要在
    //    frontmatter/Task 里指定订阅前缀模型,请求就自动走订阅额度,主会话模型不受影响。
    //    放在最前:优先级高于 per-session 供应商与 spawn 默认路由。
    //    ⚠ 本分支是订阅直连的**唯一注册点**:整块摘掉 = 订阅前缀请求 passthrough 到默认上游
    //    (预期 400/502,fail-open),不需要 revert 其它代码。
    if (isSubscriptionDirectModel(wireModel)) {
      const bridgeHandler = getResponsesBridgeHandler();
      if (!bridgeHandler) {
        log.warn('订阅前缀模型但 responses handler 不可用,passthrough(该请求预期会 400)', { wireModel });
        return null;
      }
      // 会话态(思维深度 / Fast)在决策点解析后**闭包**进 handler —— CC 不会把 bridge 模型的
      // effort / fast 放进请求体,而引擎保持零会话概念,不走任何伪 header。
      const effort = sessionId ? getSessionEffort(sessionId) : null;
      const fast = sessionId ? getSessionFastMode(sessionId) : false;
      return {
        localHandler: (args) =>
          bridgeHandler.handle({ ...args, prefs: { reasoningEffort: effort ?? undefined, fast } }),
      };
    }

    const gatewayKey = _readGatewayKey();
    const selectedProviderId = sessionId ? getSessionProvider(sessionId) : null;

    // ① 该会话显式选了供应商 → 据 catalog 统一路由。
    //    x-claude-code-session-id = cc sdkSessionId,经注入的 resolver 反解成 xdt sessionId。
    if (sessionId) {
      // wireModel 传给 scope 门:cc 内部辅助调用(权限 auto 分类器等 claude-* 小模型请求)
      // 不在订阅直连供应商(xai / openai-cc)声明的 modelPrefixes 范围内 → 返回 null,
      // 落到下方 ② 段 spawn 默认路由,分类器照常走网关/直连(issue #886)。
      const perSession = resolveSessionRouteDecision(sessionId, requestAgent, gatewayKey, wireModel);
      const recordSelectedRoute = <T extends object | null>(route: T): T => {
        if (
          requestAgent === 'claude-code'
          && route
          && (selectedProviderId === 'xd' || selectedProviderId === 'anthropic')
        ) {
          recordClaudeRequestRoute(
            ctx.reqId,
            sessionId,
            selectedProviderId === 'xd' ? 'gateway' : 'subscription',
          );
        }
        return route;
      };
      if (perSession instanceof Promise) return perSession.then(recordSelectedRoute);
      if (perSession) return recordSelectedRoute(perSession);
    }

    // ② 未显式选供应商 → 据请求凭证判定 spawn 形态(见上方注释)。
    // 计费路由旁路只记「未显式选供应商」的会话(registry 声明的语义,消费方也只在
    // providerId=null 时读)——显式选了供应商但被 scope 门放下来的辅助请求(如 xai 会话
    // 的 claude-* 分类器调用)不该往表里写死记录。
    const recordDefaultRoute =
      requestAgent === 'claude-code'
      && sessionId !== null
      && getSessionProvider(sessionId) == null;
    const recordResolvedDefaultRoute = (route: ClaudeSessionBillingRoute): void => {
      if (!recordDefaultRoute) return;
      recordClaudeSessionRoute(sessionId, route);
      recordClaudeRequestRoute(ctx.reqId, sessionId, route);
    };
    // provider-oauth spawn 的占位 key **不是可用凭证**:scope 门放下来的辅助请求
    // (如 openai / xai 来源 cc 会话里 CLI 自发的 claude-* 权限分类器调用)带着它
    // passthrough 会在网关吃确定性 401 → 误触发 auto→ask 降级(#831)。与 codex
    // ①.5 段 #890 修复同语义:占位 key 按「无可用凭证」处理,走下方换网关 key 的
    // 默认路由;真实 key(gateway-spawn)照旧 passthrough。
    const apiKeyHeader = headerValue(ctx.headers, 'x-api-key');
    const hasUsableApiKey =
      apiKeyHeader !== null && apiKeyHeader !== CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY;
    if (hasUsableApiKey) {
      // gateway-spawn:自带网关 key,passthrough。
      if (requestAgent === 'claude-code' && sessionId && selectedProviderId === 'xd') {
        // 显式 XD 会话在 live gateway key 被清除后,仍可能携带 spawn 时冻结的 x-api-key。
        // resolveSessionRouteDecision 会因缺 key 返回 null,但这条 passthrough 仍实际进入 XD Gateway。
        recordClaudeRequestRoute(ctx.reqId, sessionId, 'gateway');
      } else {
        recordResolvedDefaultRoute('gateway');
      }
      return null;
    }
    // 有界拒绝(P1):对外访问开启时,这个端口被公布给外部 CLI。走到这里的请求既没有可用
    // x-api-key(上面已判)、又没有可解析 session、又不带 authorization bearer、又不带
    // x-claude-code-session-id 头 —— 它不是 Cindy 自家 cc 子进程(oauth-spawn 必带 OAuth
    // bearer;任何 cc 子进程都带 x-claude-code-session-id;gateway-spawn 带可用 x-api-key 已在
    // 上面 return),而是本机某个直接打这个对外端口、连对外 token 都省了的匿名客户端。放行会让它
    // 经 gatewayDefaultRouteDecision 白嫖 Cindy 的网关 key。故 401,不落默认路由。
    // ⚠ 有界修复:存心伪造一个假 authorization bearer / 会话头的本机进程仍能溜过(loopback 非鉴权
    //   边界);彻底隔离需把对外监听与内部子进程代理拆到不同端口。未开启对外访问时不启用此闸,内部
    //   流量字节级不变。
    if (
      isExternalAccessEnabled()
      && sessionId === null
      && !sdkSessionId
      && headerValue(ctx.headers, 'authorization') === null
    ) {
      return externalErrorDecision(
        401,
        'external_token_required',
        'Cindy 对外模型代理需要有效的访问 token。',
      );
    }
    const decision = gatewayDefaultRouteDecision(requestAgent, gatewayKey);
    if (decision) {
      // oauth-spawn 默认:全量换网关 key(防订阅 token 泄漏到网关)。
      recordResolvedDefaultRoute('gateway');
      return decision;
    }
    if (apiKeyHeader !== null) {
      // 占位 key 且无网关 key:保持改动前行为(passthrough,上游 401)——下方的
      // Anthropic 直连支路是给 oauth-spawn 订阅 token 准备的,占位 key 不适用。
      log.warn('provider-oauth cc spawn 占位 key 且无网关 key; passthrough (预期 401)', { wireModel });
      return null;
    }
    // 没网关 key:Anthropic 模型只能直连(唯一出路),其余 passthrough + 记一条诊断。
    // 判据 = 前缀地板 ∪ 目录 anthropic 供应商模型集合(新家族改 OSS 目录即可,无需发版)。
    if (isAnthropicWireModel(wireModel, anthropicCatalogModelIds(getActiveCatalog()))) {
      recordResolvedDefaultRoute('subscription');
      return { upstreamOverride: ANTHROPIC_DIRECT_UPSTREAM };
    }
    if (wireModel) {
      // 无 key 的非 Anthropic 模型 passthrough 大概率 401 —— 路由归属不明确, 不记录。
      log.warn('claude oauth-spawn but no gateway key; non-anthropic passthrough (可能 401)', { wireModel });
    }
    return null;
  };
  return (body, ctx) => {
    const decision = route(body, ctx);
    const hasInternalPiHeader =
      headerValue(ctx.headers, 'x-cindy-pi-session-id') !== null
      || headerValue(ctx.headers, 'x-cindy-pi-session-token') !== null;
    if (!hasInternalPiHeader) return decision;
    const stripInternalPiHeaders = (
      resolved: RoutingDecision | null,
    ): RoutingDecision | null => {
      if (resolved?.localHandler) return resolved;
      return {
        ...(resolved ?? {}),
        headerDelete: [
          ...new Set([
            ...(resolved?.headerDelete ?? []),
            'x-cindy-pi-session-id',
            'x-cindy-pi-session-token',
          ]),
        ],
      };
    };
    return decision instanceof Promise
      ? decision.then(stripInternalPiHeaders)
      : stripInternalPiHeaders(decision);
  };
}

/**
 * 启动本地代理。幂等 —— 重复调用直接返回已缓存 handle。
 *
 * 即使代理启动失败,也会把 _initialized 置 true,后续 getClaudeEndpoint()
 * 直接 fallback 到真上游 URL,不会反复重试拖慢启动。
 */
export async function ensureAnthropicCompatProxyReady(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // 对外模型代理的端口策略:默认随机;用户在设置里开启对外服务时会捕获当前端口并持久化
  // (见 local-proxy IPC)。持久化了(>0)就固定绑该端口,让外部 CLI 的 ANTHROPIC_BASE_URL 稳定;
  // 固定端口被占用则 fallback 随机并回写新端口(UI 始终显示当前实际 url)。
  const pinnedPort = loadLocalProxySettings().port;
  try {
    const proxyOptions = {
      // 函数形态:model-access 凭据同步可能在 proxy 启动(splash)后才把 endpoint
      // 换成下发值;每请求现取才能保证与当前 key 同租户(proxy 内部按值 memoize)。
      upstream: () => claudeUpstreamEndpoint(),
      // 'oauth' 模式按 model 分流(claude-* → api.anthropic.com 走订阅;其余 → gateway 换 key)。
      // 'gateway' 模式恒返 null,字节级行为与扩展前一致。
      routingTransform: createModelRoutingTransform(),
      // 只读响应观察器(组合三个,互不感知):
      //   - fast mode 链路核验:tee SSE 抽上游 usage.speed(debug-gated);
      //   - 订阅余量旁路:读 anthropic-ratelimit-unified-* headers(仅订阅直连响应,
      //     同步读 header、零 body 开销),交 usageBroadcaster 落库 + 广播;
      //   - Auto 权限分类器错误检测:确定性 4xx 立即通知 coordinator 降级到 ask;
      //     瞬时 408/429/5xx 按 episode 阈值记账、持续故障才降级(见
      //     claude-auto-permission-fallback.ts);只在错误路径与「该会话有瞬时记账」的
      //     成功路径解析 request body;不 tee/改写响应;缺会话头 / id 反解失败这两类
      //     漏检走限流 warn + 识别记账落到同一份 log(否则自救通道静默失效无线索);
      //   - 自定义供应商上游错误分类广播(status≥400 且会话路由到 user 供应商时才 tee,
      //     成功路径零开销;30s 节流,见 provider-upstream-error-observer)。
      responseObserver: composeResponseObservers(
        createClaudeSubagentUsageResponseObserver(),
        createClaudeFastModeResponseObserver(log),
        createClaudeRateLimitHeadersObserver(),
        createClaudeGatewayErrorObserver(),
        // 后台活动检测:响应流按节流刷新活动时刻(覆盖长 SSE 跨过 turn 结束点仍在吐字的场景)。
        createClaudeSessionActivityResponseObserver((sdkSessionId) =>
          _resolveCcSessionId ? _resolveCcSessionId(sdkSessionId) : null,
        ),
        createClaudeAutoClassifierFailureObserver(
          (sdkSessionId) => (_resolveCcSessionId ? _resolveCcSessionId(sdkSessionId) : null),
          { logger: log },
        ),
        createProviderUpstreamErrorObserver({
          agent: 'claude-code',
          resolveUserProviderId: (requestHeaders) => {
            const sdkSessionId = requestHeaders['x-claude-code-session-id'];
            const sessionId = sdkSessionId && _resolveCcSessionId ? _resolveCcSessionId(sdkSessionId) : null;
            return sessionId ? getUserProviderIdForSession(sessionId) : null;
          },
          resolveUserProviderName: (providerId) =>
            getActiveCatalog().providers.find((provider) => provider.id === providerId)?.name ?? null,
        }),
      ),
      transformRequest: [
        // 对外模型代理:外部客户端带命名空间前缀的 model 在发往上游前剥成裸 id(仅外部请求生效)。
        // 放最前:后续 strip/修复 transform 看到的就是最终 model,与路由 transform 用原始 model 推断供应商互补。
        createExternalModelRewriteTransform(),
        // 子代理 usage 在请求阶段预留 taskId，后续用同一 reqId 关联响应，避免响应乱序交换归因。
        createClaudeSubagentUsageRequestTransform(),
        // 开头:fast mode 请求侧核验(passthrough 不改写,放最前先记 cc 实际发出的 speed/beta)。
        createClaudeFastModeRequestTransform(log),
        createActiveStripTransform({
          controller: encryptedStripController,
          enabled: () => readSilentEncryptedRetrySettings().enabled,
          strip: stripEncryptedContentFromBody,
        }),
        // 空 thinking 块主动剥离 —— always-on,独立 controller(跨厂商切回 Anthropic 模型的恢复)。
        createActiveStripTransform({
          controller: emptyThinkingStripController,
          enabled: () => true,
          strip: stripEmptyThinkingFromBody,
        }),
        // 空 text 块主动剥离 —— always-on,独立 controller(bridge 修复前落进历史的空
        // text 块,切回真 Anthropic 模型时 400 "text content blocks must be non-empty")。
        createActiveStripTransform({
          controller: emptyTextStripController,
          enabled: () => true,
          strip: stripEmptyTextFromBody,
        }),
        // 空 assistant 消息主动剥离 —— always-on,独立 controller(moonshot/kimi 空
        // thinking 占位被中断持久化后回放 400 "with role 'assistant' must not be empty";
        // 与 kimi code 官方客户端的发送前兜底同构)。
        createActiveStripTransform({
          controller: emptyAssistantStripController,
          enabled: () => true,
          strip: stripEmptyAssistantMessagesFromBody,
        }),
        // tool 配对断裂修复 —— always-on 检测即修(孤儿/前置/超编 result 丢弃 +
        // 错位前移 + 非 trailing 缺失合成占位;与 kimi code projector 的
        // consumed-scan 接力配对同构)。**必须在 dedupe 之前**:它产出的结构
        // 合法历史上 result 与 call 严格同序,dedupe 的顺序配对才等于真实配对
        // (复审实测反例: 前置 result 白占序号会致 dedupe 张冠李戴)。
        repairToolExchangeAdjacency,
        // 重复 tool_use id 唯一化 —— always-on 检测即修(moonshot/kimi 序号 id
        // 跨 turn 复用致会话安静瘫痪,2026-07 两个会话实测 `Edit_306`/`Bash_256`
        // 各复用 20+ 次;重写方案与 kosong normalize 同构,详见 transform.ts 头注)。
        // 无重复返回 null 字节透传,不需要 controller(异常在请求体里可直接检测)。
        dedupeDuplicateToolUseIds,
        // LiteLLM/provider adapter 可能把 provider_specific_fields(null) 挂到 tool_use 上，
        // 严格 Anthropic 入站 schema 不接受该扩展字段。
        stripToolUseProviderSpecificFields,
        stripNonAnthropicFields,
      ],
      recoveryRules: [
        createEncryptedContentRecoveryRule({
          enabled: () => readSilentEncryptedRetrySettings().enabled,
          onRetry: (threadId, model) => encryptedStripController.markActive(threadId, model),
        }),
        // 空 thinking 块 400 → 剥空块重发,always-on(删空块零代价,无需用户权衡)。
        createEmptyThinkingRecoveryRule({
          enabled: () => true,
          onRetry: (threadId, model) => emptyThinkingStripController.markActive(threadId, model),
        }),
        // 空 text 块 400 → 剥空块重发,always-on(同上,救 bridge 修复前污染的存量会话)。
        createEmptyTextRecoveryRule({
          enabled: () => true,
          onRetry: (threadId, model) => emptyTextStripController.markActive(threadId, model),
        }),
        // 空 assistant 消息 400 → 丢空消息重发,always-on(moonshot/kimi 空 thinking
        // 占位污染的会话;恢复一次后该 thread 发送前主动预剥,不再每轮撞 400)。
        createEmptyAssistantMessageRecoveryRule({
          enabled: () => true,
          onRetry: (threadId, model) => emptyAssistantStripController.markActive(threadId, model),
        }),
        createToolUseProviderSpecificFieldsRecoveryRule(),
        // tool 配对断裂 400(moonshot `tool_call_id is not found` / Anthropic
        // `unexpected tool_use_id` / `tool_use ids were found without tool_result`
        // / OpenAI 系 wording)→ 组合结构修复重发,always-on。
        // 两条 tool exchange 规则的 strip 同为 repairToolExchangeStructureFromBody
        // (内建 repair → dedupe 顺序,与上方主动链一致;命中顺序不再影响正确性)。
        createToolExchangeAdjacencyRecoveryRule(),
        // 重复 tool_use id 400(``tool_use` ids must be unique`)→ 组合结构修复
        // 重发,always-on(moonshot 实测不报错,但 LiteLLM 版本差 / 真 Anthropic
        // 上游会报;主动 transform 已检测即修,此为第二道防线)。
        createDuplicateToolUseIdRecoveryRule(),
      ],
      logger: log,
      // 请求体 dump 默认关(dev trace 级别 + agent 高并发会刷爆 main event loop
      // 与日志盘);诊断请求体时设 XDT_PROXY_DUMP_REQUEST_BODY=1 显式开启。
      debugDumpRequestBody: process.env.XDT_PROXY_DUMP_REQUEST_BODY === '1',
      // 上游连接跟随代理环境变量 / 系统代理(非 TUN 的代理软件场景);无代理配置时直连,
      // 行为与之前字节级一致。见 outbound-proxy-resolver.ts。
      resolveOutboundProxy: resolveDesktopOutboundProxy,
    };
    try {
      _handle = await createAnthropicCompatProxy(
        pinnedPort > 0 ? { ...proxyOptions, port: pinnedPort } : proxyOptions,
      );
    } catch (err) {
      // 固定端口不可用时 fallback 随机端口重试,并把持久化端口回写成实际绑定值,避免下次启动
      // 又撞同一个坏端口。三类可 fallback:被占用(EADDRINUSE)/ 无权限(EACCES)/ 落在 Fetch
      // 屏蔽端口(包内直接抛,SDK 连不上)。其它错误照抛给外层兜底。
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const fetchBlocked = isFetchBlockedPort(pinnedPort);
      if (pinnedPort > 0 && (code === 'EADDRINUSE' || code === 'EACCES' || fetchBlocked)) {
        log.error('固定的对外代理端口不可用,fallback 随机端口', { pinnedPort, code, fetchBlocked });
        _handle = await createAnthropicCompatProxy(proxyOptions);
        const actual = portFromProxyUrl(_handle.url);
        if (actual) setLocalProxyPort(actual);
      } else {
        throw err;
      }
    }
    log.debug('proxy ready', { url: _handle.url, upstream: claudeUpstreamEndpoint() });
  } catch (err) {
    _handle = null;
    log.error('proxy failed to start, falling back to direct upstream', {
      err: err instanceof Error ? err.message : String(err),
      fallbackEndpoint: claudeUpstreamEndpoint(),
    });
  }
}

/** 从 loopback proxy url(`http://127.0.0.1:<port>`)取端口;解析失败返回 null。 */
export function portFromProxyUrl(url: string): number | null {
  try {
    const port = Number.parseInt(new URL(url).port, 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** 当前代理是否就绪且其 url;供 IPC get-state 展示 127.0.0.1 地址与端口。未就绪返回 null。 */
export function getLocalProxyUrl(): string | null {
  return _handle?.url ?? null;
}

/**
 * 重建代理以让新的固定端口生效(用户在设置里改端口后调用)。dispose 会把
 * `_initialized` 复位,随后 ensure 按最新持久化端口重新绑定。返回重建后的实际 url。
 * 注意:会中断当前经代理的 in-flight 请求 —— 仅在用户显式改端口时用,不做常态调用。
 */
export async function restartAnthropicCompatProxy(): Promise<string | null> {
  await disposeAnthropicCompatProxy();
  await ensureAnthropicCompatProxyReady();
  return getLocalProxyUrl();
}

/**
 * proxy handle 是否就绪。'oauth' 模式的 fail-closed gate 用它判定:proxy 没起来时
 * DesktopClaudeAuthAdapter.getState() 会拒绝授权(不让 OAuth token + 直连 gateway 裸奔)。
 * 复刻 codex-proxy-host.ts:isCodexProxyHandleReady 的「显式就绪状态,不靠字符串比较」原则。
 */
export function isAnthropicCompatProxyHandleReady(): boolean {
  return _handle !== null;
}

/**
 * 给本地 Claude Code 子进程用的 endpoint。
 *
 * 退役「XD.Inc 兼容模式」开关后, proxy 恒在链路里 —— per-model(claude-* 直连
 * api.anthropic.com、其余换 gateway key)与 per-session 供应商路由都活在 proxy 的
 * routingTransform 里, 绕过 proxy 等于绕过路由器(多供应商选择会被静默丢弃)。所以:
 *
 *   proxy ready → 返回 loopback URL(请求经 proxy 做路由 + 字段适配)
 *   proxy 没起  → fail-open 回落真上游 (claudeUpstreamEndpoint()) + 日志。
 *                 oauth-spawn 下本不该到这(getState 已 gate proxy readiness, 见
 *                 auth-adapters), 记 ERROR; gateway-spawn 记 warn。
 *
 * 注意: ANTHROPIC_BASE_URL 是子进程 spawn 时传入的 env, **已存在 session 仍走老
 * endpoint**, proxy 就绪状态变化只对新建 session 生效。调用方必须先 await
 * ensureAnthropicCompatProxyReady()。
 *
 * 远端 cc-mgr 会话不走这里 —— 它用 runtimeConfig.remoteEndpoint(真上游网关), loopback
 * 远端够不到(见 runtime-configs.ts + maker-core claude-code/index.ts 的 loopback guard)。
 */
export function getClaudeEndpoint(): string {
  if (_handle) return _handle.url;
  // proxy 没起来 —— fail-open 回落真上游。
  if (_isOAuthSpawn()) {
    log.error('oauth-spawn but proxy not ready; falling back to direct upstream (getState 应已拦截)', {
      fallbackEndpoint: claudeUpstreamEndpoint(),
    });
  } else {
    log.warn('proxy not ready, falling back to direct upstream', {
      fallbackEndpoint: claudeUpstreamEndpoint(),
    });
  }
  return claudeUpstreamEndpoint();
}

/**
 * 优雅关闭。注册到 bootstrap-electron 的 onQuit('async') 阶段。
 */
export async function disposeAnthropicCompatProxy(): Promise<void> {
  if (!_handle) return;
  const h = _handle;
  _handle = null;
  _initialized = false;
  try {
    await h.dispose();
  } catch (err) {
    log.warn('proxy dispose failed', { err: err instanceof Error ? err.message : String(err) });
  }
}
