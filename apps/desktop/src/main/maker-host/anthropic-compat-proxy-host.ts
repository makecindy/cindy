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
  createEmptyAssistantMessageRecoveryRule,
  createEmptyTextRecoveryRule,
  createEmptyThinkingRecoveryRule,
  createEncryptedContentRecoveryRule,
  createToolUseProviderSpecificFieldsRecoveryRule,
  stripEmptyAssistantMessagesFromBody,
  stripEmptyTextFromBody,
  stripEmptyThinkingFromBody,
  stripEncryptedContentFromBody,
  stripNonAnthropicFields,
  stripToolUseProviderSpecificFields,
  type ProxyHandle,
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
import { recordClaudeSessionRoute } from './claude-session-route-registry.js';
import { getSessionProvider } from './session-provider-store.js';
import {
  gatewayDefaultRouteDecision,
  getUserProviderIdForSession,
  resolveSessionRouteDecision,
} from './provider-route.js';
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
  return (body, ctx) => {
    // 后台活动检测(claude-session-background-activity):凡带 cc 会话标头的请求
    // 都记一笔活动时刻。注意 routingTransform 只在 JSON POST 上被调用(server.ts
    // 按 content-type 门控),GET / 非 JSON 请求不经过这里 —— 它们由响应侧的
    // createClaudeSessionActivityResponseObserver 覆盖(观察器对所有响应生效)。
    // 开销 = 一次 header 读 + 一次活跃会话表反解 + Map.set,非 per-token 路径。
    const activitySdkSessionId = ctx.headers['x-claude-code-session-id'];
    if (activitySdkSessionId) {
      recordClaudeApiActivity(
        activitySdkSessionId,
        _resolveCcSessionId ? _resolveCcSessionId(activitySdkSessionId) : null,
      );
    }
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
      const sdkSessionId = ctx.headers['x-claude-code-session-id'];
      const xdtSessionId = sdkSessionId && _resolveCcSessionId ? _resolveCcSessionId(sdkSessionId) : null;
      const effort = xdtSessionId ? getSessionEffort(xdtSessionId) : null;
      const fast = xdtSessionId ? getSessionFastMode(xdtSessionId) : false;
      return {
        localHandler: (args) =>
          bridgeHandler.handle({ ...args, prefs: { reasoningEffort: effort ?? undefined, fast } }),
      };
    }

    const gatewayKey = _readGatewayKey();

    // ① 该会话显式选了供应商 → 据 catalog 统一路由。
    //    x-claude-code-session-id = cc sdkSessionId,经注入的 resolver 反解成 xdt sessionId。
    const sdkSessionId = ctx.headers['x-claude-code-session-id'];
    const sessionId = sdkSessionId && _resolveCcSessionId
      ? _resolveCcSessionId(sdkSessionId)
      : null;
    if (sessionId) {
      // wireModel 传给 scope 门:cc 内部辅助调用(权限 auto 分类器等 claude-* 小模型请求)
      // 不在订阅直连供应商(xai / openai-cc)声明的 modelPrefixes 范围内 → 返回 null,
      // 落到下方 ② 段 spawn 默认路由,分类器照常走网关/直连(issue #886)。
      const perSession = resolveSessionRouteDecision(sessionId, 'claude-code', gatewayKey, wireModel);
      if (perSession) return perSession;
    }

    // ② 未显式选供应商 → 据请求凭证判定 spawn 形态(见上方注释)。
    // 计费路由旁路只记「未显式选供应商」的会话(registry 声明的语义,消费方也只在
    // providerId=null 时读)——显式选了供应商但被 scope 门放下来的辅助请求(如 xai 会话
    // 的 claude-* 分类器调用)不该往表里写死记录。
    const recordDefaultRoute = sessionId !== null && getSessionProvider(sessionId) == null;
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
      if (recordDefaultRoute) recordClaudeSessionRoute(sessionId, 'gateway');
      return null;
    }
    const decision = gatewayDefaultRouteDecision('claude-code', gatewayKey);
    if (decision) {
      // oauth-spawn 默认:全量换网关 key(防订阅 token 泄漏到网关)。
      if (recordDefaultRoute) recordClaudeSessionRoute(sessionId, 'gateway');
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
      if (recordDefaultRoute) recordClaudeSessionRoute(sessionId, 'subscription');
      return { upstreamOverride: ANTHROPIC_DIRECT_UPSTREAM };
    }
    if (wireModel) {
      // 无 key 的非 Anthropic 模型 passthrough 大概率 401 —— 路由归属不明确, 不记录。
      log.warn('claude oauth-spawn but no gateway key; non-anthropic passthrough (可能 401)', { wireModel });
    }
    return null;
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

  try {
    _handle = await createAnthropicCompatProxy({
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
      //     成功路径解析 request body;不 tee/改写响应;
      //   - 自定义供应商上游错误分类广播(status≥400 且会话路由到 user 供应商时才 tee,
      //     成功路径零开销;30s 节流,见 provider-upstream-error-observer)。
      responseObserver: composeResponseObservers(
        createClaudeSubagentUsageResponseObserver(),
        createClaudeFastModeResponseObserver(log),
        createClaudeRateLimitHeadersObserver(),
        // 后台活动检测:响应流按节流刷新活动时刻(覆盖长 SSE 跨过 turn 结束点仍在吐字的场景)。
        createClaudeSessionActivityResponseObserver((sdkSessionId) =>
          _resolveCcSessionId ? _resolveCcSessionId(sdkSessionId) : null,
        ),
        createClaudeAutoClassifierFailureObserver((sdkSessionId) =>
          _resolveCcSessionId ? _resolveCcSessionId(sdkSessionId) : null,
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
      ],
      logger: log,
      // 请求体 dump 默认关(dev trace 级别 + agent 高并发会刷爆 main event loop
      // 与日志盘);诊断请求体时设 XDT_PROXY_DUMP_REQUEST_BODY=1 显式开启。
      debugDumpRequestBody: process.env.XDT_PROXY_DUMP_REQUEST_BODY === '1',
      // 上游连接跟随代理环境变量 / 系统代理(非 TUN 的代理软件场景);无代理配置时直连,
      // 行为与之前字节级一致。见 outbound-proxy-resolver.ts。
      resolveOutboundProxy: resolveDesktopOutboundProxy,
    });
    log.debug('proxy ready', { url: _handle.url, upstream: claudeUpstreamEndpoint() });
  } catch (err) {
    _handle = null;
    log.error('proxy failed to start, falling back to direct upstream', {
      err: err instanceof Error ? err.message : String(err),
      fallbackEndpoint: claudeUpstreamEndpoint(),
    });
  }
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
