/**
 * Desktop 端 codex-proxy 生命周期管理 ——
 *
 * 负责为 Codex API 模式启动一个本地 loopback 代理,把产品级 system prompt
 * 从 codex thread history 里的 developerInstructions 挪到每次 Responses 请求的
 * 顶层 instructions 尾部。这样 prompt 不落历史,compact / cold resume 后仍能
 * 每请求重注入,也不会在未 compact resume 窗口重复 developer message。
 *
 * Layer 2 只提供 standalone 基础设施:
 *   - 启动 / 关闭 proxy
 *   - 按 threadId 注册已拼好的五段 prompt
 *
 * maker-core AgentDeps 接线、spawn 时记录 per-host active、session close cleanup 都在后续层做。
 */

import {
  createAnthropicCompatProxy,
  createActiveStripTransform,
  createEncryptedContentRecoveryRule,
  createImageGenerationIdRecoveryRule,
  createInstructionsInjectionTransform,
  createInstructionsRegistry,
  createXaiModelInputRecoveryRule,
  createXaiModelInputSanitizeTransform,
  sanitizeXaiModelInputBody,
  sanitizeXaiModelInputFromBody,
  stripEncryptedContentFromBody,
  stripImageGenerationItemsWithoutIdFromBody,
  stripNonAnthropicFields,
  type ProxyHandle,
  type ResponseObserver,
  type ResponseObserverCtx,
  type RequestTransform,
  type RequestTransformCtx,
  type RoutingDecision,
  type RoutingTransform,
} from '@cindy/anthropic-compat-proxy';
import { buildVisionBridgeProxyTransform } from '../vision-bridge/vision-bridge-controller.js';
import {
  createResponsesCustomToolFunctionAdapter,
  createResponsesChatHandler,
  type ChatBridgeCapabilities,
} from '@cindy/responses-chat-bridge';
import { createResponsesAnthropicHandler } from '@cindy/responses-anthropic-bridge';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isCuratedQwen38Tag } from '../../shared/localModelRuntime.js';
import { buildCodexGatewayBaseUrl, CODEX_OAUTH_UPSTREAM } from './codex-gateway-config.js';
import { claudeUpstreamEndpoint } from './runtime-configs.js';
import {
  getActiveCatalog,
  getCatalogModelContextWindow,
  getXdGatewayModelAccessSnapshot,
} from './active-catalog.js';
import {
  gatewayDefaultRouteDecision,
  getProviderRoutingDescriptor,
  getSessionRoutingDescriptor,
  resolveProviderRouteById,
  resolveProviderRouteDecision,
  resolveSessionRoute,
  resolveSessionRouteDecision,
  resolvePendingSessionRouteDecision,
  buildLocalHandlerHeaders,
  inferProviderIdForModel,
  isHostInjectedAuthSession,
  isUserProviderSession,
  getUserProviderIdForSession,
  readProviderOAuthToken,
  providerRoutingServesWireModel,
  resolveImplicitLocalBridgeRoute,
  resolveImplicitProviderOAuthRouteDecision,
  resolveProviderOAuthControlRouteDecision,
  rewriteImplicitModelIdForRoute,
  rewriteProviderModelIdInBody,
  rewriteSessionModelIdForRoute,
} from './provider-route.js';
import type { CodexSubagentRouteSnapshot } from './codex-subagent-config.js';
import { getSessionProvider } from './session-provider-store.js';
import {
  composeResponseObservers,
  recordClaudeRateLimitHeaders,
} from './claude-rate-limit-headers-observer.js';
import { createProviderUpstreamErrorObserver, reportProviderUpstreamError } from './provider-upstream-error-observer.js';
import { createXaiProxyAuthInvalidationObserver } from './xai-auth-invalidation-host.js';
import { xaiServerSideTools } from './xai-server-side-tools.js';
import {
  encryptedStripController,
  imageGenerationStripController,
  xaiModelInputStripController,
} from './thread-strip-controllers.js';
import { createMakerLogger } from './logger-adapter.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
import { outboundFetch } from './outbound-fetch.js';
import { desktopAnthropicImageCodec } from './anthropic-image-codec.js';
import { readSilentEncryptedRetrySettings } from './silent-encrypted-retry-store.js';
import { getLogDir } from '../logger.js';
import { recordXaiRateLimitSnapshot } from '../usageBroadcaster.js';

// scope = 'codex-proxy'。保持独立 scope,方便后续 E2E 日志脚本按 codex proxy 过滤。
const log = createMakerLogger('codex-proxy');

const registry = createInstructionsRegistry();
const sessionToThread = new Map<string, string>();
const sessionToThreads = new Map<string, Set<string>>();
const threadToSession = new Map<string, string>();
const subagentRouteByParentThread = new Map<string, CodexSubagentRouteSnapshot>();
const subagentRouteByThread = new Map<string, CodexSubagentRouteSnapshot>();
const reviewerModelBySession = new Map<string, string>();
const httpRecoveryReasonByThread = new Map<string, string>();

const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review';
const CODEX_GUARDIAN_SUBAGENT = 'guardian';
const CODEX_COLLAB_SPAWN_SUBAGENT = 'collab_spawn';
const CODEX_COLLAB_ROUTE_UNAVAILABLE_CODE = 'cindy_codex_parent_route_unavailable';

let _handle: ProxyHandle | null = null;
let _startPromise: Promise<void> | null = null;
const _controlPlaneHandles = new Map<CodexProxyAuthInjection, ProxyHandle>();
const _controlPlaneStartPromises = new Map<CodexProxyAuthInjection, Promise<void>>();
let _disposeGeneration = 0;
let dumpSeq = 0;

const CODEX_RESPONSE_OBSERVER_MAX_BYTES = 2 * 1024 * 1024;

const encryptedContentRecoveryRule = createEncryptedContentRecoveryRule({
  enabled: () => readSilentEncryptedRetrySettings().enabled,
  onRetry: (threadId, model) => encryptedStripController.markActive(threadId, model),
});
const imageGenerationIdRecoveryRule = createImageGenerationIdRecoveryRule({
  onRetry: (threadId, model) => imageGenerationStripController.markActive(threadId, model),
});
const xaiModelInputRecoveryRule = createXaiModelInputRecoveryRule({
  onRetry: (threadId, model) => xaiModelInputStripController.markActive(threadId, model),
});
const CODEX_BODY_RECOVERY_RULES = [
  encryptedContentRecoveryRule,
  imageGenerationIdRecoveryRule,
  xaiModelInputRecoveryRule,
] as const;

/**
 * WS 已建立后 proxy 只转发 socket，真正的上游请求错误会由 app-server 报给 maker-core。
 * maker-core 把错误文本回传到这里，由与 HTTP recovery 完全相同的 rule 判定并登记：
 * 下一次 upgrade 返回 426，Codex 原生 transport 随即切到 HTTP，既有 strip+retry 接管。
 */
export function armCodexHttpRecovery(args: {
  sessionId: string;
  threadId: string;
  message: string;
  additionalDetails?: string | null;
}): string | null {
  const threadId = args.threadId.trim();
  if (!threadId) return null;
  const errorText = [args.message, args.additionalDetails]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n');
  if (!errorText) return null;

  const rule = CODEX_BODY_RECOVERY_RULES.find(
    (candidate) => candidate.enabled() && candidate.matches(errorText),
  );
  if (!rule) return null;

  const sessionId = args.sessionId.trim();
  const existingSessionId = threadToSession.get(threadId);
  if (sessionId && existingSessionId && existingSessionId !== sessionId) {
    log.warn('refusing to arm codex websocket recovery for a thread owned by another session', {
      sessionId,
      threadId,
      existingSessionId,
    });
    return null;
  }
  httpRecoveryReasonByThread.set(threadId, rule.id);
  const disconnectedWebSockets = _handle?.disconnectWebSocketsForThread?.(threadId) ?? 0;
  if (disconnectedWebSockets === 0) {
    httpRecoveryReasonByThread.delete(threadId);
    // startup-prewarm 没有稳定 thread header，且 shared app-server 会跨业务 session
    // 复用这些连接。不能为恢复 thread A 而全局断开匿名连接（可能正承载 thread B）；
    // 无法精确定位时保留 Codex 原生错误语义，不自动重投，也不制造跨会话降级。
    log.info('codex websocket recovery left to native transport; no scoped socket found', {
      sessionId,
      threadId,
      reason: rule.id,
    });
    return null;
  }
  if (sessionId && !existingSessionId) {
    // recovery 只需要让 unregister 能清掉 thread 标记，不能调用 bindThreadToSession：
    // 子 Agent thread 与主 thread 属于同一业务 session，但 bind 会把它当成主 thread
    // 切换并清空整个父子线程集合，连 registry 与已有 recovery 标记一起误删。
    const threads = sessionToThreads.get(sessionId) ?? new Set<string>();
    threads.add(threadId);
    sessionToThreads.set(sessionId, threads);
    threadToSession.set(threadId, sessionId);
  }
  log.info('codex websocket recovery fallback armed', {
    sessionId,
    threadId,
    reason: rule.id,
    disconnectedWebSockets,
  });
  return rule.id;
}

// codex 走 Responses API,每轮**全量重发**整个 thread 历史;导入的存量长会话
// (贴图 base64 + 加密 reasoning blob,字节数膨胀远快于 token 数)单次请求体可以
// 轻松越过 proxy 默认的 32MB —— 原生 codex 直连上游没有这道闸,曾导致导入会话
// 每轮报 "stream disconnected before completion" 且无日志(2026-07 实踩)。
// 放宽到 128MB 恢复与原生 codex 的对等;仍保留上限防内存被打爆(body 会整段
// 缓冲 + JSON.parse,该值同时是单请求的内存 / 解析停顿预算)。
const CODEX_PROXY_MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024;

export type CodexProxyAuthInjection = 'oauth-bearer' | 'env-key' | 'provider-oauth';

// proxy 路线 spawn 鉴权模式: codex 当前带的是 OAuth token(requires_openai_auth)还是 gateway key(env_key)。
// index.ts prepareCodexExtraSpawnConfig 在每次 spawn 前按本次会话 credentialMode set; routingTransform 据此决策。
// null 表示当前还没有本地 Codex app-server route 被 spawn 冻结;renderer 读 runtime route 时会按当前
// OAuth/API 状态合成展示口径,避免启动后未 spawn 前把 OAuth 用户误判成 env-key。
let _codexAuthInjection: CodexProxyAuthInjection | null = null;

/** spawn codex 前由 host 调用, 记录本次 codex 进程带的是 OAuth token 还是 gateway key。 */
export function setCodexProxyAuthInjection(mode: CodexProxyAuthInjection): void {
  _codexAuthInjection = mode;
}

/** 清掉当前本地 Codex app-server spawn-time 路由;下次 createHost 前会重新 set。 */
export function clearCodexProxyAuthInjection(): void {
  _codexAuthInjection = null;
}

/** 返回当前本地 Codex app-server spawn 时固定下来的鉴权注入方式;null 表示尚未 spawn。 */
export function getCodexProxyAuthInjectionState(): CodexProxyAuthInjection | null {
  return _codexAuthInjection;
}

/** 返回 proxy routing 使用的鉴权注入方式;未 spawn 时保守按 env-key 处理。 */
export function getCodexProxyAuthInjection(): CodexProxyAuthInjection {
  return _codexAuthInjection ?? 'env-key';
}

// gateway api key reader —— 由 host 注入(readClaudeApiKey), 避免 codex-proxy-host 直接 import
// auth-adapters(重模块, 会拖累单测加载 / 埋循环依赖)。proxy 给折扣 / api 流量换 gateway key 时调它。
let _readGatewayKey: () => string | null = () => null;
export function setCodexProxyGatewayKeyReader(fn: () => string | null): void {
  _readGatewayKey = fn;
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string {
  const direct = headers[name];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value.trim()) return value.trim();
  }
  return '';
}

function selectedThreadIdFromHeaders(headers: Readonly<Record<string, string>>): string {
  return headerValue(headers, 'thread-id') ||
    headerValue(headers, 'x-client-request-id') ||
    'unknown';
}

function guardianParentThreadIdFromHeaders(
  headers: Readonly<Record<string, string>>,
): string {
  if (headerValue(headers, 'x-openai-subagent').toLowerCase() !== CODEX_GUARDIAN_SUBAGENT) {
    return '';
  }
  return headerValue(headers, 'x-codex-parent-thread-id');
}

function isCollabSpawnRequest(headers: Readonly<Record<string, string>>): boolean {
  return headerValue(headers, 'x-openai-subagent').toLowerCase() === CODEX_COLLAB_SPAWN_SUBAGENT;
}

function sessionIdFromHeaders(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const parentThreadId = guardianParentThreadIdFromHeaders(headers);
  if (parentThreadId) return threadToSession.get(parentThreadId);

  const collabSpawn = isCollabSpawnRequest(headers);
  const selectedThreadId = collabSpawn
    ? headerValue(headers, 'thread-id')
    : selectedThreadIdFromHeaders(headers);
  const existingSessionId = threadToSession.get(selectedThreadId);
  if (existingSessionId) return existingSessionId;

  // Codex can send a spawned child's first request before thread/started reaches
  // the host. Only that explicit spawn request may lazily inherit its parent;
  // request ids and unrelated parent headers are not stable thread identities.
  if (!collabSpawn) {
    return undefined;
  }
  const childThreadId = selectedThreadId;
  const collabParentThreadId = headerValue(headers, 'x-codex-parent-thread-id');
  if (!childThreadId || !collabParentThreadId) return undefined;

  registerChildThread(collabParentThreadId, childThreadId);
  return threadToSession.get(childThreadId);
}

function subagentRouteFromHeaders(
  headers: Readonly<Record<string, string>>,
): CodexSubagentRouteSnapshot | undefined {
  // Guardian / review 等 Codex 内部审核线程有自己的模型路由。新版 app-server 可能先以
  // 通用 descendant thread/started 暴露它们，导致内存里暂时继承了父线程快照；请求头
  // 身份是最终事实。非空 subagent 身份只有 collab_spawn 属于用户配置的 Subagent。
  const subagentKind = headerValue(headers, 'x-openai-subagent').toLowerCase();
  if (subagentKind && subagentKind !== CODEX_COLLAB_SPAWN_SUBAGENT) return undefined;
  const threadId = selectedThreadIdFromHeaders(headers);
  if (threadId === 'unknown') return undefined;
  return subagentRouteByThread.get(threadId);
}

/**
 * Resolve only the independent Subagent route carried by this WS upgrade.
 *
 * A registered child already owns a frozen route snapshot. Its first
 * collab_spawn upgrade can race thread/started; when the handshake already
 * carries a real child thread id, bind it before returning 426 so Codex's HTTP
 * fallback can still resolve the frozen route if it omits parent metadata.
 */
function subagentRouteForWebSocketUpgrade(
  headers: Readonly<Record<string, string>>,
): CodexSubagentRouteSnapshot | undefined {
  const registeredRoute = subagentRouteFromHeaders(headers);
  if (registeredRoute) return registeredRoute;
  if (!isCollabSpawnRequest(headers)) return undefined;

  const parentThreadId = headerValue(headers, 'x-codex-parent-thread-id');
  if (!parentThreadId) return undefined;
  const inheritedRoute = subagentRouteByThread.get(parentThreadId)
    ?? subagentRouteByParentThread.get(parentThreadId);
  if (!inheritedRoute) return undefined;

  const childThreadId = headerValue(headers, 'thread-id');
  if (childThreadId) {
    registerChildThread(parentThreadId, childThreadId);
    return subagentRouteByThread.get(childThreadId) ?? inheritedRoute;
  }
  return inheritedRoute;
}

interface ProviderRequestContext {
  sessionId?: string;
  providerId: string | null;
  catalogModel: string;
  subagentRoute?: CodexSubagentRouteSnapshot;
}

function providerContextForRequest(
  headers: Readonly<Record<string, string>>,
  requestModel: string,
): ProviderRequestContext {
  const sessionId = sessionIdFromHeaders(headers);
  // The first collab_spawn request may arrive before thread/started. Resolve
  // the session first so lazy child registration can inherit the route snapshot
  // before request compatibility transforms inspect the effective Provider.
  const subagentRoute = subagentRouteFromHeaders(headers);
  if (subagentRoute) {
    return {
      sessionId,
      providerId: subagentRoute.providerId,
      catalogModel: subagentRoute.catalogModel,
      subagentRoute,
    };
  }
  return {
    sessionId,
    providerId: sessionId ? getSessionProvider(sessionId) : null,
    catalogModel: requestModel,
  };
}

/**
 * 网关折扣命名空间判定：`codex/` 是 Gateway wire model 的档位标识，请求必须送往
 * 网关换 key，且转发时原样保留。它不是 Codex 运行时 slug，也不参与 spawn_agent。
 */
function gatewayProviderIdForRewrittenModel(model: string): string | null {
  return model.startsWith('codex/') && model.length > 'codex/'.length ? 'xd' : null;
}

/** Applies the locked Subagent effort while preserving unrelated reasoning fields. */
function applyReasoningEffortOverride(
  body: Record<string, unknown>,
  reasoningEffort: CodexSubagentRouteSnapshot['reasoningEffort'] | undefined,
): Record<string, unknown> {
  if (reasoningEffort === undefined) return body;
  if (reasoningEffort !== null) {
    return {
      ...body,
      reasoning: isPlainObject(body.reasoning)
        ? { ...body.reasoning, effort: reasoningEffort }
        : { effort: reasoningEffort },
    };
  }
  if (!isPlainObject(body.reasoning) || !Object.hasOwn(body.reasoning, 'effort')) {
    return body;
  }
  const reasoning = { ...body.reasoning };
  delete reasoning.effort;
  const next = { ...body };
  if (Object.keys(reasoning).length > 0) next.reasoning = reasoning;
  else delete next.reasoning;
  return next;
}

/**
 * 个性化 Codex Subagent 是强制路由：Codex 内部先继承父模型创建子线程，首个
 * collab_spawn 请求按血缘登记后在这里替换成用户冻结的模型与 effort。放在所有
 * Provider 能力/兼容 transforms 之前，后续判断看到的始终是真实执行模型。
 */
function createForcedSubagentRequestTransform(): RequestTransform {
  return (body, ctx) => {
    if (!isPlainObject(body)) return null;
    // 先触发首个 collab_spawn 的懒血缘登记，再读取子线程冻结路由。
    sessionIdFromHeaders(ctx.headers);
    const route = subagentRouteFromHeaders(ctx.headers);
    if (!route) return null;
    const next: Record<string, unknown> = {
      ...body,
      model: route.catalogModel,
    };
    return applyReasoningEffortOverride(next, route.reasoningEffort);
  };
}

function unresolvedCollabSpawnRouteDecision(): RoutingDecision {
  return {
    localHandler: async ({ res }) => {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({
        error: {
          type: 'server_error',
          code: CODEX_COLLAB_ROUTE_UNAVAILABLE_CODE,
          message: 'Cindy could not resolve the parent Provider route for this spawned Codex agent.',
        },
      }));
    },
  };
}

function safeDumpName(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}

function writeTransformedBodyDump(ctx: RequestTransformCtx, body: unknown): void {
  const logDir = getLogDir();
  if (!logDir) {
    log.warn('codex proxy transformed body dump skipped because log dir is not initialized');
    return;
  }

  const threadId = selectedThreadIdFromHeaders(ctx.headers);
  dumpSeq += 1;
  const seq = dumpSeq;
  const dumpDir = path.join(logDir, 'codex-proxy-dumps');
  const dumpPath = path.join(dumpDir, `${safeDumpName(threadId)}-${String(seq).padStart(6, '0')}.json`);

  try {
    fs.mkdirSync(dumpDir, { recursive: true });
    fs.writeFileSync(
      dumpPath,
      JSON.stringify({
        seq,
        threadId,
        method: ctx.method,
        url: ctx.url,
        body,
      }, null, 2),
      'utf8',
    );
  } catch (err) {
    log.warn('codex proxy transformed body dump failed', {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function createCodexTransform(): RequestTransform {
  return createInstructionsInjectionTransform({ registry, logger: log });
}

const NESTED_SUBAGENT_EXEC_GUARD =
  'IMPORTANT: The tool declarations below are nested APIs on the `tools` object, not top-level ' +
  'function tools. Never emit a direct function call named `multi_agent_v1__spawn_agent` or ' +
  '`multi_agent_v2__spawn_agent`. Invoke it only inside this `exec` tool as JavaScript, for ' +
  'example `const result = await tools.multi_agent_v1__spawn_agent({...}); text(JSON.stringify(result));`.\n\n';

function threadHasLockedSubagentRoute(
  headers: Readonly<Record<string, string>>,
): boolean {
  const subagentKind = headerValue(headers, 'x-openai-subagent').toLowerCase();
  if (subagentKind && subagentKind !== CODEX_COLLAB_SPAWN_SUBAGENT) return false;
  const threadId = selectedThreadIdFromHeaders(headers);
  if (threadId === 'unknown') return false;
  return subagentRouteByParentThread.has(threadId) || subagentRouteByThread.has(threadId);
}

/**
 * Third-party Responses models sometimes copy a nested tool name out of the `exec` description
 * and emit it as a top-level function call. Codex rejects that shape as `unsupported call` before
 * the Subagent can start. A locked route is the only Cindy-owned path that promises this feature,
 * so reinforce the existing exec contract there without changing global agent instructions.
 */
function createLockedSubagentExecGuardTransform(): RequestTransform {
  return (body, ctx) => {
    if (!isPlainObject(body) || !threadHasLockedSubagentRoute(ctx.headers)) return null;
    if (!Array.isArray(body.tools)) return null;

    let changed = false;
    const tools = body.tools.map((tool) => {
      if (!isPlainObject(tool) || tool.type !== 'custom' || tool.name !== 'exec') return tool;
      const description = typeof tool.description === 'string' ? tool.description : '';
      if (
        description.startsWith(NESTED_SUBAGENT_EXEC_GUARD)
        || (
          !description.includes('multi_agent_v1__spawn_agent')
          && !description.includes('multi_agent_v2__spawn_agent')
        )
      ) return tool;
      changed = true;
      return {
        ...tool,
        description: `${NESTED_SUBAGENT_EXEC_GUARD}${description}`,
      };
    });
    return changed ? { ...body, tools } : null;
  };
}

function sessionUsesNativeOpenAIReviewer(
  sessionId: string,
  model: string,
  authInjection: CodexProxyAuthInjection,
): boolean {
  const explicitProviderId = getSessionProvider(sessionId);
  if (explicitProviderId) return explicitProviderId === 'openai';

  const inferredProviderId = inferProviderIdForModel(model, 'codex');
  if (inferredProviderId) return inferredProviderId === 'openai';

  // An unscoped model inherits the app-server's spawn credential. Namespaced
  // models are never treated as native OpenAI merely because a superset OAuth
  // host happens to serve the session.
  if (
    gatewayProviderIdForRewrittenModel(model) !== null ||
    model.startsWith('chatgpt/') ||
    model.startsWith('xai/')
  ) {
    return false;
  }
  return authInjection === 'oauth-bearer';
}

function providerAwareGuardianReviewerModel(
  body: unknown,
  headers: Readonly<Record<string, string>>,
  authInjection: CodexProxyAuthInjection,
): string | null {
  if (!isPlainObject(body) || body.model !== CODEX_AUTO_REVIEW_MODEL) return null;
  const parentThreadId = guardianParentThreadIdFromHeaders(headers);
  if (!parentThreadId) return null;
  const sessionId = threadToSession.get(parentThreadId);
  if (!sessionId) return null;
  const mainModel = reviewerModelBySession.get(sessionId);
  if (!mainModel || mainModel === CODEX_AUTO_REVIEW_MODEL) return null;
  return sessionUsesNativeOpenAIReviewer(sessionId, mainModel, authInjection)
    ? null
    : mainModel;
}

const GUARDIAN_PROVIDER_SEARCH_TOOL_TYPES = new Set(['web_search', 'x_search']);

function providerSearchToolChoiceReferencesRemovedTool(
  toolChoice: unknown,
  tools: readonly unknown[],
): boolean {
  if (!isPlainObject(toolChoice) || typeof toolChoice.type !== 'string') return false;
  if (!GUARDIAN_PROVIDER_SEARCH_TOOL_TYPES.has(toolChoice.type)) return false;
  return !tools.some((tool) => isPlainObject(tool) && tool.type === toolChoice.type);
}

/**
 * Guardian decides whether another action may run. Provider-hosted search
 * tools must not let that reviewer initiate an unrelated upstream network
 * action with the approval context.
 */
function stripProviderSearchTools(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.tools)) return body;
  const tools = body.tools.filter(
    (tool) =>
      !isPlainObject(tool) ||
      typeof tool.type !== 'string' ||
      !GUARDIAN_PROVIDER_SEARCH_TOOL_TYPES.has(tool.type),
  );
  if (tools.length === body.tools.length) return body;

  const next = { ...body };
  if (tools.length > 0) {
    next.tools = tools;
    if (providerSearchToolChoiceReferencesRemovedTool(next.tool_choice, tools)) {
      next.tool_choice = 'auto';
    }
  } else {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}

function createProviderAwareGuardianReviewerTransform(
  frozenAuthInjection?: CodexProxyAuthInjection,
): RequestTransform {
  return (body, ctx) => {
    if (ctx.method !== 'POST' || !isPlainObject(body)) return null;
    const parentThreadId = guardianParentThreadIdFromHeaders(ctx.headers);
    const sessionId = parentThreadId ? threadToSession.get(parentThreadId) : undefined;
    const mainModel = providerAwareGuardianReviewerModel(
      body,
      ctx.headers,
      frozenAuthInjection ?? getCodexProxyAuthInjection(),
    );
    if (!parentThreadId || !sessionId || !mainModel) return null;

    log.info('routing Codex Guardian reviewer through the session provider model', {
      sessionId,
      parentThreadId,
      fromModel: CODEX_AUTO_REVIEW_MODEL,
      toModel: mainModel,
      providerId: getSessionProvider(sessionId),
    });
    return stripProviderSearchTools({ ...body, model: mainModel });
  };
}

/**
 * Codex Code Mode 对部分 GPT-5.6 网关模型不会发出 Responses 原生搜索声明：
 * 目录里的 `supports_search_tool` / `webSearch` 能力虽为 true，但 Gateway 只看最终
 * 请求的 `tools`。插件搜索是增强项，不能作为该基础能力的前置条件，因此在明确走
 * Cindy Gateway 的 GPT-5.6 请求中补回标准 `web_search` 工具；已有声明保持原样。
 */
function createGatewayNativeWebSearchTransform(): RequestTransform {
  return (body, ctx) => {
    if (!isPlainObject(body) || typeof body.model !== 'string') return null;
    if (guardianParentThreadIdFromHeaders(ctx.headers)) return null;
    const path = ctx.url.split('?', 1)[0] ?? ctx.url;
    if (ctx.method !== 'POST' || (!path.endsWith('/responses') && path !== '/responses')) return null;

    const requestModel = body.model;
    const providerContext = providerContextForRequest(ctx.headers, requestModel);
    const { sessionId, subagentRoute } = providerContext;
    const model = providerContext.catalogModel;
    const rewrittenGatewayProviderId = gatewayProviderIdForRewrittenModel(model);
    const routeProviderId = providerContext.providerId
      ?? inferProviderIdForModel(model, 'codex')
      ?? rewrittenGatewayProviderId;
    const gatewayModel = model.startsWith('codex/') ? model.slice('codex/'.length) : model;
    if (!/^gpt-5\.6(?:$|[-.])/.test(gatewayModel)) return null;

    const authInjection = getCodexProxyAuthInjection();
    const canUseExplicitSessionRoute = Boolean(sessionId && !subagentRoute && (
      authInjection === 'oauth-bearer' ||
      isUserProviderSession(sessionId) ||
      isHostInjectedAuthSession(sessionId, 'codex')
    ));
    const explicitRouting = subagentRoute
      ? getProviderRoutingDescriptor(subagentRoute.providerId, 'codex', subagentRoute.catalogModel)
      : canUseExplicitSessionRoute && sessionId
        ? getSessionRoutingDescriptor(sessionId, 'codex', model)
        : null;
    const resolvedExplicitRoute = explicitRouting
      && sessionId
      && !subagentRoute
      && (authInjection === 'oauth-bearer' || authInjection === 'provider-oauth')
      ? resolveSessionRouteDecision(sessionId, 'codex', _readGatewayKey(), model)
      : null;
    const providerOAuthGatewayFallback = authInjection === 'provider-oauth'
      ? gatewayDefaultRouteDecision('codex', _readGatewayKey())
      : null;
    const isGatewaySession = explicitRouting
      ? explicitRouting.authStrategy === 'gateway-key' &&
        (subagentRoute
          ? _readGatewayKey() !== null
          : authInjection === 'env-key' || resolvedExplicitRoute !== null)
      // provider-oauth 的显式来源越界后，实际路由会回落默认 Gateway；没有 descriptor
      // 时也必须与 createModelRoutingTransform 保持同源。
      : rewrittenGatewayProviderId !== null ||
        authInjection === 'env-key' ||
        providerOAuthGatewayFallback !== null;
    if (!isGatewaySession) return null;

    const existingTools = Array.isArray(body.tools) ? body.tools : [];
    if (existingTools.some((tool) => isPlainObject(tool) && tool.type === 'web_search')) return null;
    return { ...body, tools: [...existingTools, { type: 'web_search' }] };
  };
}

function sessionIdFromTransformCtx(ctx: RequestTransformCtx): string | undefined {
  return sessionIdFromHeaders(ctx.headers);
}

// 通用 Chat Completions 上游(DeepSeek/GLM/Kimi 等非 OpenAI o-series)的兼容默认。
// 依据 cc-switch / opencodex 的 per-provider 处理归纳:
//   - maxTokensField='max_tokens':只有 OpenAI o-series 用 max_completion_tokens,国产厂商用 max_tokens;
//   - toolCallReasoningPlaceholder:思考模型要求 tool_call assistant 消息带非空 reasoning_content;
//   - forceAutoToolChoice:思考模型拒绝强制 tool_choice(DeepSeek reasoner)。
const CHAT_BRIDGE_DEFAULT_CAPABILITIES: ChatBridgeCapabilities = {
  developerRole: 'system',
  parallelToolCalls: true,
  maxTokensField: 'max_tokens',
  reasoningField: 'none',
  streamUsage: true,
  // Responses fields with direct Chat equivalents. Provider-specific unsupported fields can
  // be removed later when the model capability catalog becomes more granular.
  passthroughFields: [
    'temperature',
    'top_p',
    'frequency_penalty',
    'presence_penalty',
    'stop',
    'seed',
    'user',
    'metadata',
    'service_tier',
    'response_format',
    'logit_bias',
    // Token log probabilities are not restored by ChatSseTranslator yet; do not advertise
    // request passthrough until the Responses response shape is implemented.
  ],
  toolCallReasoningPlaceholder: true,
  forceAutoToolChoice: true,
};

function isGoogleGeminiChatUpstream(upstream: string): boolean {
  try {
    return new URL(upstream).hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

const MOONSHOT_CHAT_HOSTS = new Set(['api.moonshot.cn', 'api.moonshot.ai']);
/** 火山方舟(豆包)官方 DNS 边界:ark.<region>.volces.com(如 ark.cn-beijing.volces.com)。 */
const VOLCENGINE_ARK_CHAT_HOST_RE = /^ark\.[a-z0-9-]+\.volces\.com$/;
/** 阿里云百炼 Coding Plan / Token Plan / 按量付费官方 DNS 边界。 */
const DASHSCOPE_CODING_CHAT_HOSTS = new Set([
  'coding.dashscope.aliyuncs.com',
  'dashscope.aliyuncs.com',
  'token-plan.cn-beijing.maas.aliyuncs.com',
]);
/**
 * 豆包 Seed 系列 model id 的版本前缀:doubao-seed-<major>-<minor>-…。
 * 只放行 1.6 起的版本——Seed 品牌线从 1.6 开始原生多模态(官方 Chat Completions
 * 支持 image_url);万一上游日后出现更低版本号的 seed 变体,不被顺带放行。
 */
const DOUBAO_SEED_VERSION_RE = /^doubao-seed-(\d+)-(\d+)(?:-|$)/;

function isDoubaoVisionModel(model: string): boolean {
  const m = DOUBAO_SEED_VERSION_RE.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 1 || (major === 1 && minor >= 6);
}

/** 已确认支持图片输入的 Qwen model id 白名单。 */
const QWEN_IMAGE_CHAT_MODELS = new Set([
  'qwen3.6-flash',
  'qwen3.7-plus',
  'qwen3.8-max-preview',
]);

function isQwenImageChatModel(model: string): boolean {
  return QWEN_IMAGE_CHAT_MODELS.has(model);
}

function rewriteChatBridgeModel(model: string, stripPrefix: string | undefined): string {
  return stripPrefix && model.startsWith(stripPrefix)
    ? model.slice(stripPrefix.length)
    : model;
}

/**
 * 在模型级多模态能力元数据接入路由前,图片桥接先按已验证的上游能力显式开启。
 *
 * 当前覆盖:
 * - Moonshot Kimi K3
 * - Volcengine Doubao Seed 系列
 * - Alibaba Cloud Bailian Coding Plan Qwen 3.7 Plus
 *
 * 这里认官方 DNS 边界 + 上游 model,不认 provider id(预设创建后会生成用户自定义
 * id),也不对所有 openai-chat 供应商放开。未命中继续沿用 fail-closed 默认——
 * 无图片能力的上游(如 DeepSeek)保持发送前显式报错,不静默吞图。
 */
export function chatBridgeCapabilitiesForRoute(
  upstream: string,
  realModel: string,
  fallback: ChatBridgeCapabilities = CHAT_BRIDGE_DEFAULT_CAPABILITIES,
): ChatBridgeCapabilities {
  if (!isVerifiedImageChatRoute(upstream, realModel)) return fallback;
  return {
    ...fallback,
    imageInput: 'image_url',
  };
}

function isVerifiedImageChatRoute(upstream: string, realModel: string): boolean {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (realModel === 'kimi-k3') return MOONSHOT_CHAT_HOSTS.has(host);
  if (isDoubaoVisionModel(realModel)) return VOLCENGINE_ARK_CHAT_HOST_RE.test(host);
  if (isQwenImageChatModel(realModel)) return DASHSCOPE_CODING_CHAT_HOSTS.has(host);
  return false;
}

/**
 * Chat bridge 上游只收 host 明确构造的 header。绝不把 Codex/ChatGPT 请求 header
 * 原样透传，防止账号 id、OpenAI OAuth bearer 或内部 session 元数据泄漏给第三方。
 */
function createChatBridgeDecision(
  route: Awaited<ReturnType<typeof resolveSessionRoute>>,
  instructions: string | undefined,
  wireModel: string,
  requestModelOverride?: string,
  reasoningEffortOverride?: CodexSubagentRouteSnapshot['reasoningEffort'],
): RoutingDecision | null {
  if (!route || route.routing.wireProtocol !== 'openai-chat') return null;
  const { headers } = buildLocalHandlerHeaders(route, 'codex');
  const stripPrefix = route.routing.modelIdRewrite?.stripPrefix;
  const realModel = rewriteChatBridgeModel(wireModel, stripPrefix);
  // localHandler 绕过 proxy 的 responseObserver,自定义(user)供应商的上游错误不会被
  // createProviderUpstreamErrorObserver 看到。这里显式把非 2xx 上游错误喂回同一广播通道,
  // 让 Chat 桥接会话与透明自定义供应商一样弹结构化 providerError.* 提示。内置来源不广播
  // (与 observer 的 user-only 语义一致)。
  const providerId = route.providerId;
  const providerName = getActiveCatalog().providers.find((p) => p.id === providerId)?.name ?? providerId;
  const baseCapabilities: ChatBridgeCapabilities = isGoogleGeminiChatUpstream(
    route.routing.upstream,
  )
    ? {
        ...CHAT_BRIDGE_DEFAULT_CAPABILITIES,
        // Gemini 的 OpenAI 兼容层原生理解 reasoning_effort 和具名 tool choice；同时不需要
        // DeepSeek/Kimi 的 reasoning_content 占位。工具回放则必须带 Google thought signature。
        reasoningField: 'reasoning_effort',
        toolCallReasoningPlaceholder: false,
        forceAutoToolChoice: false,
        googleThoughtSignaturePlaceholder: true,
    }
    : CHAT_BRIDGE_DEFAULT_CAPABILITIES;
  const routedCapabilities = chatBridgeCapabilitiesForRoute(
    route.routing.upstream,
    realModel,
    baseCapabilities,
  );
  const capabilities =
    route.providerId === 'cindy-local-ollama' && isCuratedQwen38Tag(realModel)
      ? { ...routedCapabilities, systemMessagePolicy: 'coalesce-leading' as const }
      : routedCapabilities;
  const onUpstreamError = route.providerSource === 'user'
    ? ({ status, body }: { status: number; body: string }): void => {
        reportProviderUpstreamError({ agent: 'codex', providerId, providerName, status, bodyText: body });
      }
    : undefined;
  const handler = createResponsesChatHandler({
    upstreamBase: route.routing.upstream,
    ...(route.routing.requestPath ? { chatCompletionsPath: route.routing.requestPath } : {}),
    buildHeaders: async () => headers,
    rewriteModel: (model: string) => rewriteChatBridgeModel(model, stripPrefix),
    capabilities,
    ...(onUpstreamError ? { onUpstreamError } : {}),
    // localHandler 分支的上游请求由 chat bridge 自己发,绕开了 compat-proxy 转发层的
    // 出站代理;显式注入代理感知 fetch(见 outbound-fetch.ts)。
  }, { logger: log, fetchImpl: outboundFetch });
  return {
    localHandler: ({ rawBody, parsedBody, res }) => {
      const body = prepareLocalBridgeBody({
        rawBody,
        parsedBody,
        instructions,
        requestModelOverride,
        reasoningEffortOverride,
        bridge: 'chat',
        providerId,
        upstreamBase: route.routing.upstream,
      });
      return handler.handle({ parsedBody: body, res });
    },
  };
}

interface PrepareLocalBridgeBodyOptions {
  rawBody: Buffer;
  parsedBody: unknown;
  instructions?: string;
  requestModelOverride?: string;
  reasoningEffortOverride?: CodexSubagentRouteSnapshot['reasoningEffort'];
  bridge: 'chat' | 'anthropic';
  providerId: string;
  upstreamBase: string;
}

/**
 * localHandler runs before the shared request transform chain. Keep the preprocessing
 * needed by every Responses bridge in one place so adding another wire adapter cannot
 * accidentally lose product instructions or cross-provider encrypted-history recovery.
 */
function prepareLocalBridgeBody(opts: PrepareLocalBridgeBodyOptions): unknown {
  let body = opts.parsedBody;
  const strippedBody = stripImageGenerationItemsWithoutIdFromBody(opts.rawBody);
  if (strippedBody) {
    try {
      body = JSON.parse(strippedBody.toString('utf8'));
    } catch {
      // Keep the already parsed body if the defensive strip result cannot be parsed.
    }
  }
  // Chat Completions has no Responses-native search tool. Codex can attach it
  // automatically even for an ordinary turn, so remove it before translating
  // a provider-routed chat request instead of failing the entire request.
  if (isPlainObject(body) && (opts.requestModelOverride || opts.bridge === 'chat')) {
    body = stripProviderSearchTools({
      ...body,
      ...(opts.requestModelOverride ? { model: opts.requestModelOverride } : {}),
    });
  }
  if (isPlainObject(body)) {
    body = applyReasoningEffortOverride(body, opts.reasoningEffortOverride);
  }
  if (opts.instructions && isPlainObject(body)) {
    const existing = body.instructions;
    const existingText = Array.isArray(existing)
      ? existing.map((part) => {
        if (!isPlainObject(part) || typeof part.type !== 'string') return '';
        if (
          (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text')
          && typeof part.text === 'string'
        ) {
          return part.text;
        }
        if (part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
        return '';
      }).join('')
      : typeof existing === 'string'
        ? existing
        : '';
    body = {
      ...body,
      instructions: existingText.includes(opts.instructions)
        ? existing
        : Array.isArray(existing)
          ? [...existing, { type: 'input_text', text: `\n\n${opts.instructions}` }]
          : [existingText, opts.instructions].filter(Boolean).join('\n\n'),
    };
  }
  const historySafe = isChatGptUpstreamBase(opts.upstreamBase)
    ? null
    : rewriteCrossProviderHistoryItems(body);
  if (historySafe) {
    log.info('rewrote incompatible Codex history for local bridge upstream', {
      bridge: opts.bridge,
      providerId: opts.providerId,
      upstreamBase: opts.upstreamBase,
    });
    body = historySafe;
  }
  return body;
}

function rewriteAnthropicBridgeModel(model: string, stripPrefix: string | undefined): string {
  const stripped = stripPrefix && model.startsWith(stripPrefix) ? model.slice(stripPrefix.length) : model;
  return stripped.replace(/\[1m\]$/, '');
}

function isOfficialAnthropicUpstream(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === 'api.anthropic.com';
  } catch {
    return false;
  }
}

function anthropicBridgeUpstreamBase(
  route: NonNullable<Awaited<ReturnType<typeof resolveSessionRoute>>>,
): string {
  const isXdGatewayBridge =
    route.providerId === 'xd' && route.routing.authStrategy === 'gateway-key';
  return isXdGatewayBridge
    ? claudeUpstreamEndpoint().trim()
    : route.routing.upstream;
}

function appendCommaSeparatedHeaderToken(
  headers: Record<string, string>,
  name: string,
  token: string,
): void {
  const existingName = Object.keys(headers).find((candidate) => (
    candidate.toLowerCase() === name.toLowerCase()
  ));
  const existing = existingName ? headers[existingName] : '';
  const values = existing
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.includes(token)) values.push(token);
  if (existingName && existingName !== name) delete headers[existingName];
  headers[name] = values.join(',');
}

function claudeCodeSessionId(token: string): string {
  const hash = createHash('sha256')
    .update(`claude-code-session:${token}`, 'utf8')
    .digest('hex');
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function claudeOAuthHeaders(
  base: Record<string, string>,
  token: string,
): Record<string, string> {
  return {
    ...base,
    authorization: `Bearer ${token}`,
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    'user-agent': '@anthropic-ai/sdk/0.74.0',
    'x-app': 'cli',
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-lang': 'js',
    'x-stainless-timeout': '600',
    'x-stainless-arch': process.arch,
    'x-stainless-os': process.platform,
    'x-stainless-package-version': '0.74.0',
    'x-stainless-runtime-version': process.version.slice(1),
    'x-claude-code-session-id': claudeCodeSessionId(token),
    'x-client-request-id': randomUUID(),
  };
}

/**
 * Responses → Anthropic Messages local bridge. The bridge owns both request and
 * response translation; this host layer only resolves the selected provider, supplies
 * provider-owned credentials, and restores preprocessing skipped by localHandler.
 */
function createAnthropicBridgeDecision(
  route: Awaited<ReturnType<typeof resolveSessionRoute>>,
  instructions: string | undefined,
  wireModel: string,
  requestModelOverride?: string,
  reasoningEffortOverride?: CodexSubagentRouteSnapshot['reasoningEffort'],
): RoutingDecision | null {
  if (!route || route.routing.wireProtocol !== 'anthropic-messages') return null;
  const isXdGatewayBridge =
    route.providerId === 'xd' && route.routing.authStrategy === 'gateway-key';
  const gatewayKey = isXdGatewayBridge ? _readGatewayKey() : null;
  const upstreamBase = anthropicBridgeUpstreamBase(route);
  if (isXdGatewayBridge && (!gatewayKey || !upstreamBase)) {
    return {
      localHandler: async ({ res }) => {
        res.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify({
          error: {
            type: 'authentication_error',
            code: 'cindy_gateway_credentials_unavailable',
            message: 'Cindy AI credentials are not ready for this bridged model.',
          },
        }));
      },
    };
  }
  // For Codex, provider-oauth-header is the subscription-safe route: the host
  // injects the Claude.ai token and never forwards the Codex/OpenAI bearer.
  if (
    route.providerId === 'anthropic'
    && route.providerSource === 'builtin'
    && route.routing.authStrategy === 'provider-oauth-header'
    && !route.oauthToken
  ) {
    return {
      localHandler: async ({ res }) => {
        res.writeHead(401, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify({
          error: {
            type: 'authentication_error',
            code: 'anthropic_subscription_auth_required',
            message: 'Connect a Claude.ai subscription before using Anthropic models in Codex.',
          },
        }));
      },
    };
  }
  const usesProviderOAuth = route.routing.authStrategy === 'provider-oauth-header';
  const isAnthropicSubscriptionOAuth =
    usesProviderOAuth
    && route.providerId === 'anthropic'
    && route.providerSource === 'builtin';
  const buildProviderHeaders = (token: string | null): Record<string, string> => {
    const { headers: baseHeaders } = buildLocalHandlerHeaders(
      token === route.oauthToken ? route : { ...route, oauthToken: token },
      'codex',
    );
    let headers = { ...baseHeaders };
    if (isAnthropicSubscriptionOAuth) {
      if (token) headers = claudeOAuthHeaders(headers, token);
    } else if (route.routing.authStrategy === 'api-key-header') {
      if (route.apiKey) {
        headers['x-api-key'] = route.apiKey;
      } else if (!headerValue(headers, 'x-api-key')) {
        headers['x-api-key'] = 'cindy-missing-custom-provider-api-key';
      }
    } else if (isXdGatewayBridge && gatewayKey) {
      // 上游 wire 是 Anthropic Messages，复用 Claude Code 的网关鉴权形态；同时覆盖
      // Authorization，确保 Codex/ChatGPT bearer 永远不会离开本机。
      headers['x-api-key'] = gatewayKey;
      headers.authorization = `Bearer ${gatewayKey}`;
    } else if (route.routing.authStrategy === 'none') {
      delete headers.authorization;
      delete headers['x-api-key'];
    }
    const catalogContextWindow = getCatalogModelContextWindow(
      providerId,
      'codex',
      wireModel,
      stripPrefix,
    );
    if (
      wireModel.endsWith('[1m]')
      || (
        isOfficialAnthropicUpstream(upstreamBase)
        && catalogContextWindow !== null
        && catalogContextWindow >= 1_000_000
      )
    ) {
      appendCommaSeparatedHeaderToken(
        headers,
        'anthropic-beta',
        'context-1m-2025-08-07',
      );
    }
    return headers;
  };
  const providerId = route.providerId;
  const providerName = getActiveCatalog().providers.find((p) => p.id === providerId)?.name ?? providerId;
  const stripPrefix = route.routing.modelIdRewrite?.stripPrefix;
  const supportsPromptCaching =
    isXdGatewayBridge || isOfficialAnthropicUpstream(upstreamBase);
  const onUpstreamError = route.providerSource === 'user'
    ? ({ status, body }: { status: number; body: string }): void => {
        reportProviderUpstreamError({ agent: 'codex', providerId, providerName, status, bodyText: body });
      }
    : undefined;
  const handler = createResponsesAnthropicHandler({
    upstreamBase,
    ...(route.routing.requestPath ? { requestPath: route.routing.requestPath } : {}),
    authMode: isAnthropicSubscriptionOAuth ? 'oauth' : 'api-key',
    buildHeaders: async () => buildProviderHeaders(route.oauthToken),
    ...(usesProviderOAuth
      ? {
          refreshHeaders: async ({
            requestHeaders,
          }: {
            status: 401 | 403;
            body: string;
            requestHeaders: Readonly<Record<string, string>>;
          }) => {
            const authorization = headerValue(requestHeaders, 'authorization');
            const staleToken = authorization?.replace(/^Bearer\s+/i, '');
            const token = await readProviderOAuthToken(providerId, 'codex', {
              forceRefresh: true,
              ...(staleToken ? { staleToken } : {}),
            });
            return token ? buildProviderHeaders(token) : null;
          },
        }
      : {}),
    rewriteModel: (model) => rewriteAnthropicBridgeModel(model, stripPrefix),
    promptCaching: supportsPromptCaching,
    automaticPromptCaching: isOfficialAnthropicUpstream(upstreamBase),
    strictTools: isOfficialAnthropicUpstream(upstreamBase),
    supportsThinking: isOfficialAnthropicUpstream(upstreamBase) || isXdGatewayBridge
      ? undefined
      : () => false,
    supportsAdaptiveThinking: isOfficialAnthropicUpstream(upstreamBase) || isXdGatewayBridge
      ? undefined
      : () => false,
    imageCodec: desktopAnthropicImageCodec,
    ...(onUpstreamError ? { onUpstreamError } : {}),
    // 账号额度旁路 —— 只给「内置 Anthropic + 订阅 OAuth + 官方 hostname」这一种路由
    // 装。桥的 localHandler 绕开了 compat-proxy 的转发层, 转发层上的
    // createClaudeRateLimitHeadersObserver 看不到这些响应(见 #2626), 所以额度只能
    // 从这里回喂; 解析与去抖仍走 observer 那份共用状态, 不复制第二份。
    //
    // 其余形态一律不装: API key / 自定义兼容供应商 / XD Gateway 的响应要么没有
    // unified headers, 要么根本不属于这个 Claude 订阅账号, 误写会污染快照。
    ...(isAnthropicSubscriptionOAuth && isOfficialAnthropicUpstream(upstreamBase)
      ? {
          onUpstreamResponse: ({ responseHeaders, requestHeaders }: {
            responseHeaders: Headers;
            requestHeaders: Readonly<Record<string, string>>;
          }) => {
            // Fetch `Headers` 不支持索引取值, 直接传下去会被静默解析成 null;
            // 迭代出的 key 一律小写, 正是解析函数要求的形态。
            recordClaudeRateLimitHeaders({
              upstreamBase,
              responseHeaders: Object.fromEntries(responseHeaders),
              requestHeaders,
            });
          },
        }
      : {}),
  }, {
    logger: log,
    fetchImpl: outboundFetch,
  });
  return {
    localHandler: ({ rawBody, parsedBody, ctx, res }) => {
      const body = prepareLocalBridgeBody({
        rawBody,
        parsedBody,
        instructions,
        requestModelOverride,
        reasoningEffortOverride,
        bridge: 'anthropic',
        providerId,
        upstreamBase,
      });
      return handler.handle({ parsedBody: body, ctx, res });
    },
  };
}

function createLocalBridgeDecision(
  route: Awaited<ReturnType<typeof resolveSessionRoute>>,
  instructions: string | undefined,
  wireModel: string,
  requestModelOverride: string | undefined,
  threadId: string,
  reasoningEffortOverride?: CodexSubagentRouteSnapshot['reasoningEffort'],
): RoutingDecision | null {
  if (!route) return null;
  if (route.routing.wireProtocol === 'openai-chat') {
    const decision = createChatBridgeDecision(
      route,
      instructions,
      wireModel,
      requestModelOverride,
      reasoningEffortOverride,
    );
    if (decision) {
      recordCodexThreadUpstreamForDiagnostics(threadId, route.routing.upstream);
    }
    return decision;
  }
  if (route.routing.wireProtocol === 'anthropic-messages') {
    const decision = createAnthropicBridgeDecision(
      route,
      instructions,
      wireModel,
      requestModelOverride,
      reasoningEffortOverride,
    );
    if (decision) {
      recordCodexThreadUpstreamForDiagnostics(
        threadId,
        anthropicBridgeUpstreamBase(route),
      );
    }
    return decision;
  }
  return null;
}

function moveInstructionsIntoInput(body: Record<string, unknown>): Record<string, unknown> | null {
  const instructions = body.instructions;
  if (typeof instructions !== 'string' || instructions.length === 0) return null;
  // xAI Responses examples/API schema carry system prompt through input messages, not top-level instructions.
  const systemMessage = { type: 'message', role: 'system', content: instructions };
  const next: Record<string, unknown> = { ...body };
  delete next.instructions;

  if (Array.isArray(body.input)) {
    next.input = [systemMessage, ...body.input];
    return next;
  }
  if (typeof body.input === 'string') {
    next.input = [systemMessage, { role: 'user', content: body.input }];
    return next;
  }
  if (body.input === undefined || body.input === null) {
    next.input = [systemMessage];
    return next;
  }
  log.warn('xAI Codex request has non-standard input while moving instructions', {
    inputType: typeof body.input,
  });
  next.input = [systemMessage, body.input];
  return next;
}

function xaiRealModelId(model: unknown): string | null {
  if (typeof model !== 'string' || model.length === 0) return null;
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
}

function supportsXaiReasoning(model: string | null): boolean {
  if (!model) return true;
  const xaiProvider = getActiveCatalog().providers.find((provider) => provider.id === 'xai');
  const namespacedModel = `xai/${model}`;
  const catalogModel = (xaiProvider?.models.codex ?? []).find((candidate) => candidate.id === namespacedModel);
  return (catalogModel?.efforts.length ?? 0) > 0;
}

function stripUnsupportedXaiReasoning(body: Record<string, unknown>): Record<string, unknown> | null {
  if (supportsXaiReasoning(xaiRealModelId(body.model))) return null;

  let changed = false;
  const next: Record<string, unknown> = { ...body };
  if ('reasoning' in next) {
    delete next.reasoning;
    changed = true;
  }
  return changed ? next : null;
}

const XAI_SUPPORTED_TOOL_TYPES = new Set([
  'function',
  'web_search',
  'x_search',
  'collections_search',
  'file_search',
  'code_execution',
  'code_interpreter',
  'mcp',
  'shell',
]);

function xaiToolChoiceAfterSanitize(
  toolChoice: unknown,
  tools: readonly unknown[],
): unknown {
  if (!isPlainObject(toolChoice) || typeof toolChoice.type !== 'string') return toolChoice;

  const referencesSurvivingTool = (choice: Record<string, unknown>) => tools.some((tool) => {
    if (!isPlainObject(tool) || tool.type !== choice.type) return false;
    if (choice.type !== 'function') return true;
    return typeof choice.name === 'string' && tool.name === choice.name;
  });

  if (toolChoice.type === 'allowed_tools' && Array.isArray(toolChoice.tools)) {
    const allowedTools = toolChoice.tools.filter(
      (choice): choice is Record<string, unknown> => isPlainObject(choice) && referencesSurvivingTool(choice),
    );
    return allowedTools.length > 0 ? { ...toolChoice, tools: allowedTools } : 'none';
  }

  // Fail closed: a forced choice that references a removed tool (e.g. a
  // cache-only web_search that was dropped, or an unsupported namespace tool)
  // must NOT widen into 'auto', which would let the model call surviving tools
  // the caller never authorized. Collapse to 'none' so no tool is callable.
  return referencesSurvivingTool(toolChoice) ? toolChoice : 'none';
}

function sanitizeXaiTools(
  body: Record<string, unknown>,
  options: { preserveNoneToolChoice?: boolean; preserveSerialToolCalls?: boolean } = {},
): Record<string, unknown> | null {
  if (!Array.isArray(body.tools)) return null;

  let changed = false;
  const tools: unknown[] = [];
  for (const tool of body.tools) {
    if (!isPlainObject(tool) || typeof tool.type !== 'string' || !XAI_SUPPORTED_TOOL_TYPES.has(tool.type)) {
      changed = true;
      continue;
    }
    if (tool.type === 'web_search') {
      // A cache-only request must not silently become a live web-search request
      // just because xAI/Grok cannot represent external_web_access=false.
      const toolRecord = tool as Record<string, unknown>;
      if (toolRecord.external_web_access === false) {
        changed = true;
        continue;
      }
      const nextTool: Record<string, unknown> = { type: 'web_search' };
      for (const key of ['filters', 'enable_image_understanding', 'enable_image_search']) {
        if (key in tool) nextTool[key] = toolRecord[key];
      }
      if (Object.keys(nextTool).length !== Object.keys(tool).length) changed = true;
      tools.push(nextTool);
      continue;
    }
    tools.push(tool);
  }
  if (!changed) return null;

  const next: Record<string, unknown> = { ...body };
  if (tools.length > 0) {
    next.tools = tools;
    next.tool_choice = xaiToolChoiceAfterSanitize(next.tool_choice, tools);
  } else {
    delete next.tools;
    // All declared tools were filtered out. When server-side x_search is
    // re-injected afterwards, a tool_choice that *references a removed tool*
    // (an object forced choice, an emptied allowed_tools, or 'required') must
    // collapse to 'none' so the model cannot widen the caller's authorization
    // by auto-calling the injected search. 'auto' does NOT reference a
    // specific tool — it means "choose any available tool" — so it stays,
    // letting Grok use the re-injected x_search as the caller intended; a
    // request that had no tool_choice (or already 'none') is left untouched.
    // When nothing is re-injected (Guardian / cache-only search), drop the
    // control field entirely — a 'none' with no tools is still an invalid xAI
    // request (PR #2444 Codex P1/P2).
    if (options.preserveNoneToolChoice) {
      const choice = next.tool_choice;
      if (
        choice !== undefined
        && choice !== 'none'
        && choice !== 'auto'
      ) {
        next.tool_choice = 'none';
      }
    } else {
      delete next.tool_choice;
    }
    if (!options.preserveSerialToolCalls) {
      delete next.parallel_tool_calls;
    }
  }
  return next;
}

/**
 * 给 xAI 会话恒定补上 xAI 的服务端搜索工具(当前是 `x_search`,Grok 原生搜 X)。
 *
 * Codex 自己只会声明 OpenAI 系的内建工具,不知道 xAI 还有 x_search;不补的话用户选了
 * Grok 也拿不到 X 的实时视野(见 xai-server-side-tools.ts)。补在**已有 tools 末尾**:
 * 位置固定 + 只由 model 决定 → 同一会话逐轮请求的 tools 列表恒定,不破坏前缀稳定性。
 * 上游已经带了同名工具(用户/Codex 自己声明过)则原样保留,不重复也不覆盖其参数。
 *
 * `tool_choice:'required'`(必须调用所提供工具之一)的处理与 bridge 侧同口径:required 作用于
 * 整个 tools 数组,附加服务端工具后模型可能用 x_search 顶替调用方强制要的 function call。
 * 这里同样**不**因此摘掉工具声明(那会让 tools 前缀在会话中途变动),而是在能精确表达时把
 * tool_choice 收窄成指名唯一那个 function;有多个 function tool 时 Responses 无法表达
 * 「required 但只限这几个」,保留 required 并接受该残余风险。
 */
function narrowXaiForcedToolChoice(
  body: Record<string, unknown>,
  tools: unknown[],
): Record<string, unknown> | null {
  if (body.tool_choice !== 'required') return null;
  const functionTools = tools.filter(
    (tool) => isPlainObject(tool) && tool.type === 'function' && typeof tool.name === 'string',
  );
  if (functionTools.length !== 1) return null;
  const only = functionTools[0] as Record<string, unknown>;
  return { ...body, tool_choice: { type: 'function', name: only.name } };
}

function hasCacheOnlySearchProhibition(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.tools)) return false;
  return body.tools.some(
    (tool) => {
      if (!isPlainObject(tool) || tool.type !== 'web_search') return false;
      return (tool as Record<string, unknown>).external_web_access === false;
    },
  );
}

function ensureXaiServerSideTools(body: Record<string, unknown>): Record<string, unknown> | null {
  const realModel = xaiRealModelId(body.model);
  if (!realModel) return null;
  const serverTools = xaiServerSideTools(realModel);
  if (serverTools.length === 0) return null;
  // A cache-only web_search (external_web_access: false) must not be silently
  // upgraded to a live x_search. xAI cannot represent the prohibition, so we
  // dropped the web_search in sanitizeXaiTools; do not re-add a live search.
  if (hasCacheOnlySearchProhibition(body)) return null;

  const existing = Array.isArray(body.tools) ? body.tools : [];
  const declaredTypes = new Set(
    existing.map((tool) => (isPlainObject(tool) && typeof tool.type === 'string' ? tool.type : '')),
  );
  const missing = serverTools.filter((tool) => !declaredTypes.has(tool.type));
  // 工具已齐时仍要判 tool_choice 收窄:x_search 可能是上游自己声明的。
  const nextTools = missing.length > 0 ? [...existing, ...missing] : existing;
  const withTools = missing.length > 0 ? { ...body, tools: nextTools } : body;
  const narrowed = narrowXaiForcedToolChoice(withTools, nextTools);
  if (narrowed) return narrowed;
  return missing.length > 0 ? withTools : null;
}

/**
 * ByteDance Seed accepts standard function tools and web search. Codex also
 * emits namespaced and other built-in descriptors that Volcengine rejects
 * before the request reaches the model. Its web-search descriptor must also
 * be reduced to the standard shape: Codex's `external_web_access` extension
 * is rejected as an unknown field.
 */
function isByteDanceSeedModel(model: unknown): boolean {
  return typeof model === 'string' && (
    model.startsWith('bytedance-seed/') ||
    model.startsWith('doubao-seed-')
  );
}

function isVolcengineArkResponsesRouting(ctx: RequestTransformCtx, model: unknown): boolean {
  if (typeof model !== 'string' || model.length === 0) return false;
  const providerContext = providerContextForRequest(ctx.headers, model);
  const routing = providerContext.subagentRoute
    ? getProviderRoutingDescriptor(
        providerContext.subagentRoute.providerId,
        'codex',
        providerContext.subagentRoute.catalogModel,
      )
    : providerContext.sessionId
      ? getSessionRoutingDescriptor(providerContext.sessionId, 'codex', model)
      : null;
  if (!routing || (routing.wireProtocol ?? 'openai-responses') !== 'openai-responses') return false;

  try {
    const url = new URL(routing.upstream);
    return url.protocol === 'https:' && VOLCENGINE_ARK_CHAT_HOST_RE.test(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isByteDanceSeedRequest(
  body: Record<string, unknown>,
  ctx: RequestTransformCtx,
): boolean {
  // The catalog model uses a provider namespace, while Volcengine's native
  // model IDs use doubao-seed-* and user-defined aliases may use neither.
  // The selected official Ark Responses route is the authoritative fallback.
  return isByteDanceSeedModel(body.model) || isVolcengineArkResponsesRouting(ctx, body.model);
}

function seedToolChoiceReferencesRemovedTool(
  toolChoice: unknown,
  tools: Record<string, unknown>[],
): boolean {
  if (!isPlainObject(toolChoice) || typeof toolChoice.type !== 'string') return false;

  return !tools.some((tool) => {
    if (tool.type !== toolChoice.type) return false;
    if (toolChoice.type !== 'function') return true;
    return typeof toolChoice.name === 'string' && tool.name === toolChoice.name;
  });
}

function sanitizeByteDanceSeedTools(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.tools)) return null;

  let changed = false;
  const tools: Record<string, unknown>[] = [];
  for (const tool of body.tools) {
    if (!isPlainObject(tool)) {
      changed = true;
      continue;
    }
    if (tool.type === 'function') {
      tools.push(tool);
      continue;
    }
    if (tool.type === 'web_search') {
      // Seed cannot represent Codex's cache-only search policy. Dropping the
      // tool preserves the caller's explicit prohibition on live web access.
      if (tool.external_web_access === false) {
        changed = true;
        continue;
      }
      tools.push({ type: 'web_search' });
      if (Object.keys(tool).length !== 1) changed = true;
      continue;
    }
    changed = true;
  }
  if (!changed) return null;

  const next: Record<string, unknown> = { ...body };
  if (tools.length > 0) {
    next.tools = tools;
    if (seedToolChoiceReferencesRemovedTool(next.tool_choice, tools)) next.tool_choice = 'auto';
  } else {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}

const STRICT_GATEWAY_TOOL_HISTORY_MODELS = new Set([
  'moonshotai/kimi-k3',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
]);
// DeepSeek V4's Responses compatibility endpoint accepts the host's patch
// custom tool, but rejects every other custom tool (notably Codex's `exec`).
// Keep ordinary function tools untouched: the restriction is specifically on
// the Responses `custom` tool dialect, not on function calling as a whole.
const DEEPSEEK_V4_MODELS = new Set([
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
]);
const DEEPSEEK_V4_SUPPORTED_CUSTOM_TOOL_NAMES = new Set(['apply_patch']);
const RESPONSE_TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call']);
const RESPONSE_TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

function responseToolCallId(item: unknown, output: boolean): string | null {
  if (!isPlainObject(item)) return null;
  const supportedTypes = output ? RESPONSE_TOOL_OUTPUT_TYPES : RESPONSE_TOOL_CALL_TYPES;
  if (!supportedTypes.has(typeof item.type === 'string' ? item.type : '')) return null;
  return typeof item.call_id === 'string' && item.call_id.length > 0 ? item.call_id : null;
}

function stripEmptyResponseMessage(item: unknown): { item: unknown; changed: boolean } | null {
  if (!isPlainObject(item) || item.type !== 'message') return { item, changed: false };
  if (item.content === '') return null;
  if (!Array.isArray(item.content)) return { item, changed: false };

  const content = item.content.filter((part) => !(
    isPlainObject(part) &&
    (part.type === 'input_text' || part.type === 'output_text') &&
    part.text === ''
  ));
  if (content.length === 0) return null;
  return content.length === item.content.length
    ? { item, changed: false }
    : { item: { ...item, content }, changed: true };
}

/** Volcengine requires replayed assistant messages to carry their output status and non-empty text. */
function normalizeByteDanceSeedInput(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.input)) return null;

  let changed = false;
  const input: unknown[] = [];
  for (const item of body.input) {
    const normalized = stripEmptyResponseMessage(item);
    if (!normalized) {
      changed = true;
      continue;
    }
    if (normalized.changed) changed = true;

    const nextItem = normalized.item;
    if (
      isPlainObject(nextItem) &&
      nextItem.type === 'message' &&
      nextItem.role === 'assistant' &&
      typeof nextItem.status !== 'string'
    ) {
      changed = true;
      input.push({ ...nextItem, status: 'completed' });
      continue;
    }
    input.push(nextItem);
  }
  return changed ? { ...body, input } : null;
}

/**
 * LiteLLM converts gateway Responses history to Chat Completions for these models.
 * Their native APIs require every assistant tool call to be followed immediately
 * by its tool result, while Codex may persist an assistant progress message between
 * the Responses function_call and function_call_output items. Codex may also persist
 * empty assistant output_text items, which Moonshot rejects after history conversion.
 * Consecutive calls form one parallel assistant group, so their matched outputs must
 * be moved after the whole group rather than inserted between calls.
 */
function normalizeStrictGatewayHistory(
  body: Record<string, unknown>,
  routingModel = typeof body.model === 'string' ? body.model : '',
): Record<string, unknown> | null {
  if (
    !STRICT_GATEWAY_TOOL_HISTORY_MODELS.has(routingModel) ||
    !Array.isArray(body.input)
  ) {
    return null;
  }

  const originalInput = body.input;
  const normalizedInput: unknown[] = [];
  for (const item of originalInput) {
    const normalized = stripEmptyResponseMessage(item);
    if (normalized) normalizedInput.push(normalized.item);
  }

  const matchedOutputs = new Map<number, number>();
  const usedOutputIndexes = new Set<number>();
  const outputIndexesByCallId = new Map<string, number[]>();
  const outputCursorByCallId = new Map<string, number>();
  for (let index = 0; index < normalizedInput.length; index += 1) {
    const outputCallId = responseToolCallId(normalizedInput[index], true);
    if (!outputCallId) continue;
    const indexes = outputIndexesByCallId.get(outputCallId) ?? [];
    indexes.push(index);
    outputIndexesByCallId.set(outputCallId, indexes);
  }

  for (let callIndex = 0; callIndex < normalizedInput.length; callIndex += 1) {
    const callId = responseToolCallId(normalizedInput[callIndex], false);
    if (!callId) continue;

    const outputIndexes = outputIndexesByCallId.get(callId);
    if (!outputIndexes) continue;
    let cursor = outputCursorByCallId.get(callId) ?? 0;
    while (cursor < outputIndexes.length && outputIndexes[cursor] <= callIndex) cursor += 1;
    if (cursor >= outputIndexes.length) continue;

    const outputIndex = outputIndexes[cursor];
    outputCursorByCallId.set(callId, cursor + 1);
    matchedOutputs.set(callIndex, outputIndex);
    usedOutputIndexes.add(outputIndex);
  }

  const outputIndexesByGroupEnd = new Map<number, number[]>();
  for (let groupStart = 0; groupStart < normalizedInput.length;) {
    if (!responseToolCallId(normalizedInput[groupStart], false)) {
      groupStart += 1;
      continue;
    }
    let groupEnd = groupStart;
    while (
      groupEnd + 1 < normalizedInput.length &&
      responseToolCallId(normalizedInput[groupEnd + 1], false)
    ) {
      groupEnd += 1;
    }
    const outputIndexes: number[] = [];
    for (let callIndex = groupStart; callIndex <= groupEnd; callIndex += 1) {
      const outputIndex = matchedOutputs.get(callIndex);
      if (outputIndex !== undefined) outputIndexes.push(outputIndex);
    }
    if (outputIndexes.length > 0) {
      outputIndexesByGroupEnd.set(groupEnd, outputIndexes.sort((a, b) => a - b));
    }
    groupStart = groupEnd + 1;
  }

  const input: unknown[] = [];
  for (let index = 0; index < normalizedInput.length; index += 1) {
    if (usedOutputIndexes.has(index)) continue;
    input.push(normalizedInput[index]);
    const outputIndexes = outputIndexesByGroupEnd.get(index);
    if (outputIndexes) {
      for (const outputIndex of outputIndexes) input.push(normalizedInput[outputIndex]);
    }
  }
  const changed =
    input.length !== originalInput.length ||
    input.some((item, index) => item !== originalInput[index]);
  return changed ? { ...body, input } : null;
}

function createStrictGatewayHistoryCompatTransform(): RequestTransform {
  return (body, ctx) => {
    if (!isPlainObject(body) || typeof body.model !== 'string') return null;
    const routingModel = providerContextForRequest(ctx.headers, body.model).catalogModel;
    return normalizeStrictGatewayHistory(body, routingModel);
  };
}

function deepSeekToolChoiceReferencesRemovedCustomTool(
  toolChoice: unknown,
  tools: readonly unknown[],
): boolean {
  if (!isPlainObject(toolChoice) || toolChoice.type !== 'custom' || typeof toolChoice.name !== 'string') {
    return false;
  }
  return !tools.some((tool) =>
    tool === toolChoice.name ||
    (isPlainObject(tool) && tool.type === 'custom' && tool.name === toolChoice.name),
  );
}

/**
 * DeepSeek V4 rejects Codex's general-purpose custom `exec` tool before it
 * reaches the model, while accepting `apply_patch`. Filter only that custom
 * tool dialect so function/MCP declarations keep their existing semantics.
 */
function sanitizeDeepSeekV4CustomTools(body: unknown): Record<string, unknown> | null {
  if (!isPlainObject(body)) return null;
  if (!DEEPSEEK_V4_MODELS.has(typeof body.model === 'string' ? body.model : '')) return null;
  if (!Array.isArray(body.tools)) return null;

  let changed = false;
  const tools: unknown[] = [];
  for (const tool of body.tools) {
    const customToolName =
      typeof tool === 'string'
        ? tool
        : isPlainObject(tool) && tool.type === 'custom' && typeof tool.name === 'string'
          ? tool.name
          : null;
    if (customToolName !== null && !DEEPSEEK_V4_SUPPORTED_CUSTOM_TOOL_NAMES.has(customToolName)) {
      changed = true;
      continue;
    }
    tools.push(tool);
  }
  if (!changed) return null;

  const next: Record<string, unknown> = { ...body };
  if (tools.length > 0) {
    next.tools = tools;
    if (deepSeekToolChoiceReferencesRemovedCustomTool(next.tool_choice, tools)) next.tool_choice = 'auto';
  } else {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}

/** Seed accepts the reasoning effort, but rejects Responses' summary selector. */
function sanitizeByteDanceSeedReasoning(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!isPlainObject(body.reasoning) || !('summary' in body.reasoning)) {
    return null;
  }

  const reasoning = { ...body.reasoning };
  delete reasoning.summary;

  const next: Record<string, unknown> = { ...body };
  if (Object.keys(reasoning).length > 0) next.reasoning = reasoning;
  else delete next.reasoning;
  return next;
}

function createByteDanceSeedResponsesCompatTransform(): RequestTransform {
  return (body, ctx) => {
    if (!isPlainObject(body)) return null;
    if (!isByteDanceSeedRequest(body, ctx)) return null;
    let changed = false;
    let current = body;
    const withSanitizedTools = sanitizeByteDanceSeedTools(current);
    if (withSanitizedTools) {
      current = withSanitizedTools;
      changed = true;
    }
    const withNormalizedInput = normalizeByteDanceSeedInput(current);
    if (withNormalizedInput) {
      current = withNormalizedInput;
      changed = true;
    }
    const withSanitizedReasoning = sanitizeByteDanceSeedReasoning(current);
    if (withSanitizedReasoning) {
      current = withSanitizedReasoning;
      changed = true;
    }
    return changed ? current : null;
  };
}

function createXaiResponsesCompatTransform(): RequestTransform {
  return (body, ctx) => {
    if (!isPlainObject(body)) return null;
    const requestModel = typeof body.model === 'string' ? body.model : '';
    const providerContext = providerContextForRequest(ctx.headers, requestModel);
    const explicitProviderId = providerContext.providerId;
    const inferredProviderId =
      explicitProviderId ?? (typeof body.model === 'string' ? inferProviderIdForModel(body.model, 'codex') : null);
    if (inferredProviderId !== 'xai') return null;
    // 与路由的 scope 门同源:xai 会话里非 xai/ 前缀的请求会被 resolveSessionRouteDecision
    // 放回默认路由(ChatGPT/网关),body 不能再按 xAI 语义改写(挪 instructions / 剥
    // reasoning 会破坏默认上游的请求),transform 是否生效必须与路由是否捕获一致。
    const wireModel = providerContext.subagentRoute?.catalogModel
      ?? (typeof body.model === 'string' ? body.model : undefined);
    if (!providerRoutingServesWireModel('xai', 'codex', wireModel)) return null;
    let changed = false;
    let current = moveInstructionsIntoInput(body);
    if (current) changed = true;
    else current = body;

    // Preserve tool_choice:'none' / parallel_tool_calls only when server-side
    // x_search will be re-injected afterwards. For Guardian requests and
    // cache-only search prohibitions (external_web_access:false) no x_search
    // is added, so leaving control fields on a now-empty tools list produces
    // an invalid request. Clean them instead.
    // Detect cache-only on the ORIGINAL body because sanitizeXaiTools removes
    // the web_search descriptor before we inspect the result.
    const isGuardian = Boolean(guardianParentThreadIdFromHeaders(ctx.headers));
    const realModelId = xaiRealModelId(requestModel);
    const canInjectServerTools =
      realModelId !== null && xaiServerSideTools(realModelId).length > 0;
    const willReinjectTools =
      !isGuardian && canInjectServerTools && !hasCacheOnlySearchProhibition(body);

    const withSanitizedTools = sanitizeXaiTools(current, {
      preserveNoneToolChoice: willReinjectTools,
      preserveSerialToolCalls: willReinjectTools,
    });
    if (withSanitizedTools) {
      current = withSanitizedTools;
      changed = true;
    }

    // 补服务端工具排在 sanitize 之后:先按 xAI schema 清掉 Codex 专属工具,再追加 x_search,
    // 保证注入项不会被同一轮的裁剪逻辑改形或丢掉。
    // Guardian must retain xAI's schema/input compatibility, but it must not
    // gain provider-hosted search tools while reviewing another action.
    // Cache-only search (external_web_access:false) must not silently become
    // a live x_search — skip injection on that path too.
    if (willReinjectTools) {
      const withServerSideTools = ensureXaiServerSideTools(current);
      if (withServerSideTools) {
        current = withServerSideTools;
        changed = true;
      }
    }

    const withoutUnsupportedReasoning = stripUnsupportedXaiReasoning(current);
    if (withoutUnsupportedReasoning) {
      current = withoutUnsupportedReasoning;
      changed = true;
    }

    const withNormalizedInputItems = sanitizeXaiModelInputBody(current, {
      supportsReasoning: supportsXaiReasoning(xaiRealModelId(current.model)),
    });
    if (withNormalizedInputItems) {
      current = withNormalizedInputItems;
      changed = true;
    }
    return changed ? current : null;
  };
}

function needsExecFunctionAdapter(
  body: Record<string, unknown>,
  ctx: RequestTransformCtx,
  frozenAuthInjection?: CodexProxyAuthInjection,
): boolean {
  const requestModel = typeof body.model === 'string' ? body.model : '';
  const providerContext = providerContextForRequest(ctx.headers, requestModel);
  const authInjection = frozenAuthInjection ?? getCodexProxyAuthInjection();
  const implicitProviderId = inferProviderIdForModel(requestModel, 'codex');
  let routing: ReturnType<typeof getProviderRoutingDescriptor> = null;

  if (providerContext.subagentRoute) {
    routing = getProviderRoutingDescriptor(
      providerContext.subagentRoute.providerId,
      'codex',
      providerContext.subagentRoute.catalogModel,
    );
  } else if (providerContext.providerId) {
    // A built-in provider recorded on the session is not necessarily the
    // provider that receives the request. In env-key mode, for example, the
    // built-in OpenAI session still falls through to the default XD gateway.
    // Compatibility transforms must inspect that same effective route rather
    // than the session's stale provider label.
    const adopted = explicitProviderRouteIsAdopted(
      providerContext.sessionId,
      undefined,
      authInjection,
    );
    routing = adopted
      ? getSessionRoutingDescriptor(providerContext.sessionId!, 'codex', requestModel)
      : getProviderRoutingDescriptor('xd', 'codex', requestModel);
  } else if (implicitProviderId) {
    // Only implicit provider-oauth routes are adopted without a session. A
    // user/API-key provider merely sharing a model id does not win routing.
    const inferred = getProviderRoutingDescriptor(implicitProviderId, 'codex', requestModel);
    routing = inferred?.authStrategy === 'provider-oauth-header' ? inferred : null;
  }

  if (!routing) {
    // Mirror decideCodexRoute's default destination: oauth-bearer regular
    // models stay on ChatGPT, while env-key/provider-oauth and codex/* models
    // use the XD gateway's Responses compatibility contract.
    const defaultProviderId =
      authInjection === 'oauth-bearer' && gatewayProviderIdForRewrittenModel(requestModel) === null
        ? 'openai'
        : 'xd';
    routing = getProviderRoutingDescriptor(defaultProviderId, 'codex', requestModel);
  }

  return (routing?.wireProtocol ?? 'openai-responses') === 'openai-responses'
    && routing?.supportsResponsesCustomTools === false;
}

/**
 * The XD Gateway claims this wire model for its codex routing when the active
 * catalog exposes it under `xd.models.codex`. We use the catalog membership
 * (not `providerRoutingServesWireModel`, which only consults routing
 * descriptors and is universal for `xd`) so that a non-xd provider that also
 * lists the same id stays authoritative for its own compat transform.
 *
 * When the catalog is non-authoritative (a /models fetch is pending or
 * failed), an empty codex list must NOT be used as negative evidence: an
 * implicit session still defaults to the XD Gateway, so skipping cleanup here
 * would let namespace tools reach Grok untouched and re-trigger the schema 400
 * this transform exists to prevent. In that state clean unconditionally for
 * implicit routes (PR #2444 Codex P1).
 */
function xdProviderClaimsWireModel(wireModel: string): boolean {
  if (!wireModel.startsWith('x-ai/grok')) return false;
  const { authoritative, models } = getXdGatewayModelAccessSnapshot();
  if (!authoritative) {
    // Negative evidence is unavailable. The env-key default route and the
    // implicit-default both resolve to XD when no provider is explicitly
    // selected, so treat an unverified grok wire model as gateway-owned.
    return true;
  }
  const xdProvider = getActiveCatalog().providers.find((provider) => provider.id === 'xd');
  if (xdProvider?.models.codex?.some((candidate) => candidate.id === wireModel)) return true;
  // Authoritative gateway snapshot may also carry wire models outside the
  // static catalog codex list.
  return models.some((m) => m.id === wireModel);
}

/**
 * The XD Gateway also exposes Grok models under the `x-ai/` namespace. They
 * stay on the gateway route (unlike the first-party `xai/` OAuth provider),
 * but the upstream Grok Responses schema still rejects Codex namespace tools.
 * Keep this transform deliberately narrow: gateway routing and the model
 * namespace must both match before applying the same tool-shape cleanup.
 */
/**
 * Whether the request's session provider route is actually adopted by the
 * router for the current auth injection. Mirrors createModelRoutingTransform's
 * canUseExplicitSessionRoute: under `env-key`, a built-in session provider
 * (e.g. the default `openai` catalog entry) is NOT adopted — the request
 * falls through decideCodexRoute/gateway default and lands on the XD gateway
 * even though the session records a providerId. Trusting that provider's
 * (universal) routing descriptor would skip Grok cleanup and let namespace
 * tools reach Grok (PR #2444 Codex P2).
 */
function explicitProviderRouteIsAdopted(
  sessionId: string | undefined,
  subagentRoute: { providerId: string } | undefined,
  authInjection: CodexProxyAuthInjection,
): boolean {
  if (subagentRoute) return true;
  if (!sessionId) return false;
  return (
    authInjection === 'oauth-bearer'
    || isUserProviderSession(sessionId)
    || isHostInjectedAuthSession(sessionId, 'codex')
  );
}

function createGatewayGrokResponsesCompatTransform(
  frozenAuthInjection?: CodexProxyAuthInjection,
): RequestTransform {
  return (body, ctx) => {
    if (!isPlainObject(body)) return null;
    const requestModel = typeof body.model === 'string' ? body.model : '';
    if (!requestModel.startsWith('x-ai/grok')) return null;
    // Use providerContextForRequest so subagent-frozen routes resolve to xd
    // even when the parent session belongs to a different provider. Only
    // clean tools when the effective provider for THIS request is xd.
    const providerContext = providerContextForRequest(ctx.headers, requestModel);
    if (providerContext.providerId === 'xd') return sanitizeXaiTools(body);
    // An explicit non-xd provider owns this request only when (a) the router
    // actually adopts the session route for this auth mode, and (b) that
    // provider natively serves the wire model. A built-in `openai` session
    // under env-key is NOT adopted (the request passes through to XD), and a
    // provider-oauth xAI session with an out-of-scope `x-ai/grok*` request
    // falls back to XD via gatewayDefaultRouteDecision — in both cases the
    // namespace tools must still be cleaned (PR #2444 Codex P2).
    if (
      providerContext.providerId !== null
      && explicitProviderRouteIsAdopted(
        providerContext.sessionId,
        providerContext.subagentRoute,
        frozenAuthInjection ?? getCodexProxyAuthInjection(),
      )
      && providerRoutingServesWireModel(
        providerContext.providerId,
        'codex',
        providerContext.catalogModel ?? requestModel,
      )
    ) {
      return null;
    }
    // Implicit session (no explicit provider), or an explicit session that is
    // not adopted under the current auth mode. The request still lands on the
    // XD gateway when the xd catalog owns this wire model (env-key default
    // route, or an implicit default that resolves to xd). Clean whenever xd
    // owns the catalog entry, matching the routing scope.
    if (!xdProviderClaimsWireModel(requestModel)) return null;
    return sanitizeXaiTools(body);
  };
}

/**
 * 跨来源恢复的加密压缩历史兼容(Greptile P1, PR #265):
 *
 * OpenAI 远端压缩会把早期历史替换成加密 compaction 块(只有 ChatGPT 后端能解)。
 * 该会话切到 XD / xAI / 自定义供应商后按原 thread id resume,持久化历史里的加密块
 * 会被逐请求重放给读不懂它的上游 → 请求被拒、会话卡死。客户端无法解密转换,
 * 唯一可行的降级是:发往**非 ChatGPT 上游**时把加密块替换成明文占位 user message,
 * 明确告知模型「压缩点之前的上下文不可用」,保留压缩点之后仍在历史里的对话继续跑。
 * 判断去向用 ctx.upstreamBase(引擎按最终路由注入),不复刻路由逻辑。
 * ChatGPT 路由(chatgpt.com)原样透传,远端压缩语义不受影响。
 */
const COMPACTION_UNAVAILABLE_NOTE =
  '[context note] Earlier conversation history was compacted into an encrypted snapshot by the ' +
  'OpenAI subscription backend and is not readable on the current model provider. Treat the ' +
  'conversation from this point on as the available context; ask the user if earlier details are needed.';

function isChatGptUpstreamBase(upstreamBase: string | undefined): boolean {
  if (!upstreamBase) return false;
  try {
    return new URL(upstreamBase).hostname === new URL(CODEX_OAUTH_UPSTREAM).hostname;
  } catch {
    return false;
  }
}

/**
 * 把 body.input 里无法跨供应商重放的 Codex 历史降级成目标上游可接受的形态。
 * 返回 null = 无需改写。透明转发路径(transform 链)与 localHandler 路径共用。
 *
 * - 加密 compaction 仍替换成明文上下文缺失提示。
 * - 多 Agent 历史会在 agent_message.content 里夹带仅原供应商可解的 encrypted_content；
 *   非 ChatGPT 上游会直接拒绝整次请求。只删除这些嵌套密文，保留可读正文与路由元数据；
 *   若消息只剩密文则整条丢弃。
 * - reasoning.encrypted_content 不属于本故障；继续交给后续供应商兼容层判断，
 *   不在这里扩大删除面。
 */
function rewriteCrossProviderHistoryItems(body: unknown): Record<string, unknown> | null {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return null;
  let changed = false;
  const input: unknown[] = [];
  for (const item of body.input) {
    if (
      isPlainObject(item) &&
      (item.type === 'compaction' || item.type === 'context_compaction') &&
      typeof item.encrypted_content === 'string' &&
      item.encrypted_content.length > 0
    ) {
      changed = true;
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: COMPACTION_UNAVAILABLE_NOTE }],
      });
      continue;
    }
    if (isPlainObject(item) && item.type === 'agent_message' && Array.isArray(item.content)) {
      const content = item.content.filter(
        (part) => !(isPlainObject(part) && part.type === 'encrypted_content'),
      );
      if (content.length !== item.content.length) {
        changed = true;
        if (content.length > 0) input.push({ ...item, content });
        continue;
      }
    }
    input.push(item);
  }
  return changed ? { ...body, input } : null;
}

export function createCrossProviderCompactionCompatTransform(): RequestTransform {
  return (body, ctx) => {
    // upstreamBase 未注入(理论不发生)按非 ChatGPT 保守处理?否——保守方向是不改写:
    // 改写会丢加密块,误伤真 ChatGPT 请求的代价(远端压缩语义被破坏)高于维持现状。
    if (!ctx.upstreamBase || isChatGptUpstreamBase(ctx.upstreamBase)) return null;
    const replaced = rewriteCrossProviderHistoryItems(body);
    if (!replaced) return null;
    log.info('rewrote incompatible Codex history for non-ChatGPT upstream', {
      reqId: ctx.reqId,
      upstreamBase: ctx.upstreamBase,
      threadId: selectedThreadIdFromHeaders(ctx.headers),
    });
    return replaced;
  };
}

const MINIMAX_RESPONSES_UPSTREAMS: ReadonlySet<string> = new Set([
  'https://api.minimaxi.com/v1',
  'https://api.minimax.io/v1',
]);

function isMiniMaxResponsesSession(ctx: RequestTransformCtx, requestModel: string): boolean {
  const providerId = providerContextForRequest(ctx.headers, requestModel).providerId;
  if (!providerId) return false;
  const upstream = getActiveCatalog().providers.find((provider) => provider.id === providerId)
    ?.routing.codex?.upstream.replace(/\/+$/, '');
  return upstream !== undefined && MINIMAX_RESPONSES_UPSTREAMS.has(upstream);
}

/** MiniMax Responses 不接受 xhigh 或 reasoning summary，路由前收敛到官方支持字段。 */
function createMiniMaxResponsesCompatTransform(): RequestTransform {
  return (body, ctx) => {
    if (
      !isPlainObject(body)
      || typeof body.model !== 'string'
      || !isMiniMaxResponsesSession(ctx, body.model)
    ) return null;
    const reasoning = body.reasoning;
    if (!isPlainObject(reasoning)) return null;
    let changed = false;
    const nextReasoning = { ...reasoning };
    if (nextReasoning.effort === 'xhigh') {
      nextReasoning.effort = 'high';
      changed = true;
    }
    if ('summary' in nextReasoning) {
      delete nextReasoning.summary;
      changed = true;
    }
    return changed ? { ...body, reasoning: nextReasoning } : null;
  };
}

function createProviderModelRewriteTransform(): RequestTransform {
  return (body, ctx) => {
    if (isPlainObject(body) && typeof body.model === 'string') {
      const subagentRoute = subagentRouteFromHeaders(ctx.headers);
      if (subagentRoute) {
        // 强制子线程模型已在前置 transform 写成 catalog id。这里只应用 Provider
        // 自己声明的 wire rewrite（如 xai/ 或自定义命名空间）；Gateway 的 codex/
        // 是 wire 档位标识，没有 modelIdRewrite，因而原样保留。
        const rewritten = rewriteProviderModelIdInBody(
          subagentRoute.providerId,
          'codex',
          { ...body, model: subagentRoute.catalogModel },
        );
        return rewritten ?? { ...body, model: subagentRoute.catalogModel };
      }
    }
    const sessionId = sessionIdFromTransformCtx(ctx);
    const explicitProviderId = sessionId ? getSessionProvider(sessionId) : null;
    if (sessionId && explicitProviderId) return rewriteSessionModelIdForRoute(sessionId, 'codex', body);
    return rewriteImplicitModelIdForRoute('codex', body);
  };
}

function createDumpTransform(): RequestTransform {
  return (body, ctx) => {
    writeTransformedBodyDump(ctx, body);
    return null;
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function responseStringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRequestMeta(requestBody: Buffer): {
  model: string | null;
  requestServiceTier: string | null;
} {
  const body = parseJsonObject(requestBody.toString('utf8'));
  if (!body) return { model: null, requestServiceTier: null };
  const model = responseStringField(body, 'model');
  const serviceTier = responseStringField(body, 'service_tier') ?? responseStringField(body, 'serviceTier');
  return {
    model,
    requestServiceTier: serviceTier,
  };
}

function readProviderResponseMeta(body: Record<string, unknown>): {
  responseId: string | null;
  model: string | null;
  serviceTier: string | null;
} {
  const response = isPlainObject(body.response) ? body.response : body;
  return {
    responseId: responseStringField(response, 'id'),
    model: responseStringField(response, 'model'),
    serviceTier: responseStringField(response, 'service_tier') ?? responseStringField(response, 'serviceTier'),
  };
}

function selectedThreadIdFromObserver(ctx: ResponseObserverCtx): string {
  return selectedThreadIdFromHeaders(ctx.requestHeaders);
}

function logProviderServiceTier(ctx: ResponseObserverCtx, body: Record<string, unknown>): boolean {
  const request = readRequestMeta(ctx.requestBody);
  const upstream = readProviderResponseMeta(body);
  const threadId = selectedThreadIdFromObserver(ctx);
  const sessionId = sessionIdFromHeaders(ctx.requestHeaders) ?? null;
  log.info('codex provider service tier observed', {
    reqId: ctx.reqId,
    threadId,
    sessionId,
    upstreamBase: ctx.upstreamBase,
    status: ctx.status,
    model: upstream.model ?? request.model,
    requestServiceTier: request.requestServiceTier,
    upstreamServiceTier: upstream.serviceTier,
    responseId: upstream.responseId,
  });
  return true;
}

function numericHeader(headers: Readonly<Record<string, string>>, name: string): number | undefined {
  const raw = headers[name.toLowerCase()];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

// 精确解析 host 判定,不用 startsWith 子串判断——'https://api.x.aievil.com' 也能
// 通过前缀检查(CodeQL js/incomplete-url-substring-sanitization)。
function isXaiUpstream(upstreamBase: string): boolean {
  try {
    const url = new URL(upstreamBase);
    return url.protocol === 'https:' && url.hostname === 'api.x.ai';
  } catch {
    return false;
  }
}

function maybeRecordXaiRateLimit(ctx: ResponseObserverCtx): void {
  if (ctx.status < 200 || ctx.status >= 300) return;
  if (!isXaiUpstream(ctx.upstreamBase)) return;
  const info = {
    limitRequests: numericHeader(ctx.responseHeaders, 'x-ratelimit-limit-requests'),
    remainingRequests: numericHeader(ctx.responseHeaders, 'x-ratelimit-remaining-requests'),
    limitTokens: numericHeader(ctx.responseHeaders, 'x-ratelimit-limit-tokens'),
    remainingTokens: numericHeader(ctx.responseHeaders, 'x-ratelimit-remaining-tokens'),
  };
  if (Object.values(info).every((v) => v === undefined)) return;
  recordXaiRateLimitSnapshot(info);
}

function tryReadSseEvent(line: string): { event: string | null; data: Record<string, unknown> | null } | null {
  const parts = line.split(/\r?\n/);
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const part of parts) {
    if (part.startsWith('event:')) event = part.slice('event:'.length).trim();
    else if (part.startsWith('data:')) dataLines.push(part.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return null;
  const dataText = dataLines.join('\n').trim();
  if (!dataText || dataText === '[DONE]') return null;
  return { event, data: parseJsonObject(dataText) };
}

function createCodexResponseObserver(): ResponseObserver {
  return (ctx) => {
    maybeRecordXaiRateLimit(ctx);
    if (ctx.method !== 'POST') return null;
    const path = ctx.url.split('?', 1)[0] ?? ctx.url;
    if (!path.endsWith('/responses') && path !== '/responses') return null;
    if (ctx.status < 200 || ctx.status >= 300) return null;
    const contentType = ctx.responseHeaders['content-type'] ?? '';
    const isSse = contentType.toLowerCase().includes('text/event-stream');
    const isJson = contentType.toLowerCase().includes('application/json');
    if (!isSse && !isJson) return null;

    let done = false;
    let total = 0;
    let text = '';
    const processSseFrame = (item: string) => {
      const evt = tryReadSseEvent(item);
      if (!evt?.data) return;
      if (evt.event && evt.event !== 'response.completed') return;
      if (!evt.event) {
        const type = responseStringField(evt.data, 'type');
        if (type && type !== 'response.completed') return;
      }
      const response = isPlainObject(evt.data.response) ? evt.data.response : evt.data;
      const serviceTier = responseStringField(response, 'service_tier') ?? responseStringField(response, 'serviceTier');
      const type = responseStringField(evt.data, 'type');
      if (!serviceTier && evt.event !== 'response.completed' && type !== 'response.completed') return;
      done = logProviderServiceTier(ctx, evt.data);
    };

    const drainSse = (flush: boolean) => {
      const chunks = text.split(/\r?\n\r?\n/);
      text = chunks.pop() ?? '';
      for (const item of chunks) {
        processSseFrame(item);
        if (done) break;
      }
      if (!done && flush && text.trim()) {
        processSseFrame(text);
        text = '';
      }
    };

    const ingest = (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > CODEX_RESPONSE_OBSERVER_MAX_BYTES) {
        done = true;
        log.warn('codex provider service tier observer skipped oversized response', {
          reqId: ctx.reqId,
          threadId: selectedThreadIdFromObserver(ctx),
          status: ctx.status,
          bytes: total,
          maxBytes: CODEX_RESPONSE_OBSERVER_MAX_BYTES,
        });
        return;
      }
      text += chunk.toString('utf8');
      if (isSse) drainSse(false);
    };

    return {
      onData: ingest,
      onEnd: () => {
        if (done) return;
        if (isSse) {
          drainSse(true);
          return;
        }
        const body = parseJsonObject(text);
        if (!body) return;
        done = logProviderServiceTier(ctx, body);
      },
      onError: (err) => {
        if (done) return;
        log.warn('codex provider service tier observer stream error', {
          reqId: ctx.reqId,
          threadId: selectedThreadIdFromObserver(ctx),
          err: err.message,
        });
      },
    };
  };
}

/**
 * 纯函数: 按 model(原始, 含 codex/ 前缀)+ spawn 鉴权注入方式决定 **默认** 上游 / 鉴权 override。
 * (会话显式选了供应商时由 resolveSessionRouteDecision 优先接管,不会走到这里。)
 *   - env-key spawn(codex 已带 gateway key): 全程 null(走默认上游 gateway, 不动 header)。
 *   - oauth-bearer spawn(codex 带 OAuth token):
 *       codex/ 折扣模型 → 换 gateway key, 默认上游(gateway); 无 key 则 null(passthrough, 上游会 401)。
 *       普通模型        → override 上游到 ChatGPT, 透传 OAuth token(不动 header)= 订阅默认。
 * 退役了全局 api 开关:「普通模型也走网关」改由 per-session 显式选 XD 来源触发,不再是全局默认。
 */
export function decideCodexRoute(opts: {
  model: string;
  authInjection: CodexProxyAuthInjection;
  gatewayKey: string | null;
}): RoutingDecision | null {
  if (opts.authInjection === 'env-key' || opts.authInjection === 'provider-oauth') return null;
  if (!opts.model) return null;
  const toGateway = gatewayProviderIdForRewrittenModel(opts.model) !== null;
  if (toGateway) {
    if (!opts.gatewayKey) return null;
    return { headerOverride: { authorization: `Bearer ${opts.gatewayKey}` } };
  }
  // 普通模型 + oauth-bearer → ChatGPT 后端, 透传 codex 带的 OAuth token + chatgpt-account-id(订阅默认)。
  return { upstreamOverride: CODEX_OAUTH_UPSTREAM };
}

export function createModelRoutingTransform(
  frozenAuthInjection?: CodexProxyAuthInjection,
): RoutingTransform {
  return (body, ctx) => {
    // body 可能为 undefined —— 无 body 的 GET(典型: codex models-manager 的 `GET /models` 轮询,
    // 引擎现在也会对它跑路由)。不再因 body 非对象就短路;会话解析只依赖 headers,model 字段可选。
    const gatewayKey = _readGatewayKey();
    const authInjection = frozenAuthInjection ?? getCodexProxyAuthInjection();
    const requestModel = isPlainObject(body) && typeof body.model === 'string' ? body.model : '';
    const reportedModel =
      providerAwareGuardianReviewerModel(body, ctx.headers, authInjection) ??
      requestModel;
    const threadId = selectedThreadIdFromHeaders(ctx.headers);
    const sessionId = sessionIdFromHeaders(ctx.headers);
    if (!sessionId && isCollabSpawnRequest(ctx.headers)) {
      return unresolvedCollabSpawnRouteDecision();
    }
    // 个性化子代理先继承父模型完成创建，再由前置 transform 强制写入冻结的
    // Provider/catalog model。嵌套子线程继承同一份路由快照。
    const subagentRoute = subagentRouteFromHeaders(ctx.headers);
    const model = subagentRoute?.catalogModel ?? reportedModel;
    const explicitProviderId = subagentRoute?.providerId
      ?? (sessionId ? getSessionProvider(sessionId) : null);
    const pendingRoute = sessionId && !subagentRoute
      ? resolvePendingSessionRouteDecision(sessionId, model || undefined)
      : null;
    if (pendingRoute) return pendingRoute;
    const selectedRouting = subagentRoute
      ? getProviderRoutingDescriptor(
          subagentRoute.providerId,
          'codex',
          subagentRoute.catalogModel,
        )
      : sessionId
        ? getSessionRoutingDescriptor(sessionId, 'codex', model || undefined)
        : null;
    const selectedUsesLocalBridge =
      ctx.method === 'POST'
      && Boolean(model)
      && (
        selectedRouting?.wireProtocol === 'openai-chat'
        || selectedRouting?.wireProtocol === 'anthropic-messages'
      );
    if (explicitProviderId === 'cindy-local-ollama') {
      log.debug('codex managed ollama route', {
        sessionId,
        providerId: explicitProviderId,
        wireProtocol: selectedRouting?.wireProtocol ?? null,
        bridgeKind: selectedUsesLocalBridge ? 'local-bridge' : 'passthrough',
        upstream: selectedRouting?.upstream ?? null,
        method: ctx.method,
        path: ctx.url.split('?', 1)[0],
      });
    }

    if (subagentRoute) {
      if (
        selectedRouting?.authStrategy === 'oauth-passthrough'
        && authInjection !== 'oauth-bearer'
      ) {
        return unresolvedCollabSpawnRouteDecision();
      }
      if (selectedUsesLocalBridge) {
        return resolveProviderRouteById(
          subagentRoute.providerId,
          'codex',
          subagentRoute.catalogModel,
        ).then((localRoute) => {
          return createLocalBridgeDecision(
            localRoute,
            threadId ? registry.get(threadId) : undefined,
            subagentRoute.catalogModel,
            subagentRoute.catalogModel !== requestModel
              ? subagentRoute.catalogModel
              : undefined,
            threadId,
            subagentRoute.reasoningEffort,
          ) ?? unresolvedCollabSpawnRouteDecision();
        });
      }
      return resolveProviderRouteDecision(
        subagentRoute.providerId,
        'codex',
        gatewayKey,
        subagentRoute.catalogModel,
      ).then((resolved) => resolved?.decision ?? unresolvedCollabSpawnRouteDecision());
    }

    // ① 该会话显式选了供应商 → 据 catalog 统一路由。thread-id header → threadToSession 反解 xdt sessionId。
    //    oauth-bearer 态全量适用;env-key 态默认全量走网关、per-session 无意义(与 decideCodexRoute 的
    //    env-key 短路一致,内置三家保持旧行为)。例外:自定义(user)供应商和 host 注入鉴权的
    //    供应商(provider-oauth-header 如 xAI、通用 Runner 的 oauth-token)必须按会话路由,
    //    因为它们的鉴权由 proxy 覆盖,不依赖 Codex 子进程凭证。
    if (sessionId && (
      authInjection === 'oauth-bearer' ||
      isUserProviderSession(sessionId) ||
      isHostInjectedAuthSession(sessionId, 'codex') ||
      selectedUsesLocalBridge
    )) {
      if (selectedUsesLocalBridge && model) {
        return resolveSessionRoute(sessionId, 'codex', model).then((localRoute) => {
          return createLocalBridgeDecision(
            localRoute,
            threadId ? registry.get(threadId) : undefined,
            model,
            model !== requestModel ? model : undefined,
            threadId,
          );
        });
      }
      // model 传给 scope 门(空串 = 控制面 GET,不受范围限制);声明了 modelPrefixes 的
      // 供应商(如 xai)只捕获自家命名空间的请求,其余回落默认路由。
      const perSession = resolveSessionRouteDecision(sessionId, 'codex', gatewayKey, model || undefined);
      if (perSession) return perSession;
      // scope 门放下来的请求在 provider-oauth spawn 下没有可用凭证兜底:子进程只带占位
      // env key,直落默认网关必 401(#890 Codex review 第二轮指出)。换网关 key 给它一条
      // 真正可用的默认路由(与 cc ② 段 oauth-spawn 默认换 key 同语义);没网关 key 时保持
      // 原 null(passthrough,上游 401),行为与占位 key 直发一致,不额外兜底。
      if (authInjection === 'provider-oauth' && model) {
        const fallback = gatewayDefaultRouteDecision('codex', gatewayKey);
        if (fallback) return fallback;
        log.warn('provider-oauth session out-of-scope model but no gateway key; passthrough (预期 401)', { model });
      }
    }

    // ①.5 隐式来源(providerId/sessionProvider=null):
    //   - Chat / Anthropic Messages wire 按模型选择器相同的默认来源进入本地 bridge;
    //   - xai/grok-* 等唯一 provider-oauth 来源仍注入对应 OAuth 并透明转发。
    // 两者都必须先于 Codex 默认 ChatGPT/XD 分支，避免协议或凭证落错上游。
    if (!explicitProviderId && model) {
      if (sessionId && ctx.method === 'POST') {
        return resolveImplicitLocalBridgeRoute(model, 'codex').then((localRoute) => {
          if (localRoute) {
            return createLocalBridgeDecision(
              localRoute,
              threadId ? registry.get(threadId) : undefined,
              model,
              model !== requestModel ? model : undefined,
              threadId,
            );
          }
          const implicitProviderOAuth = resolveImplicitProviderOAuthRouteDecision(
            model,
            'codex',
            gatewayKey,
          );
          if (implicitProviderOAuth) return implicitProviderOAuth;
          return decideCodexRoute({ model, authInjection, gatewayKey });
        });
      }
      const implicitProviderOAuth = resolveImplicitProviderOAuthRouteDecision(model, 'codex', gatewayKey);
      if (implicitProviderOAuth) return implicitProviderOAuth;
    }

    // ③ 无会话且无 model = 不属于任何 session 的控制面请求(典型: codex models-manager 的
    //    `GET /models` 轮询)。它没有 provider 上下文可解析,默认会掉静态默认上游(网关)、带着子进程
    //    spawn 时那把凭证 —— oauth-bearer 揣的 OAuth token 在网关无效(要 sk-)→ 401。
    //    故按 spawn 凭证回它的原生后端: oauth-bearer → ChatGPT 订阅后端(只 override 上游、透传 OAuth
    //    token,等价 stock codex 订阅模式轮 /models 的去处); provider-oauth → 唯一 provider-oauth
    //    供应商的上游/令牌(当前 xAI),避免把占位 key 打到网关; env-key → null(留默认网关, sk- key 本就有效)。
    //    `!model` 这道闸确保真实 /responses(永远带 model)绝不落进此分支,杜绝注册时序竞争误伤推理请求。
    if (!sessionId && !model) {
      if (authInjection === 'oauth-bearer') return { upstreamOverride: CODEX_OAUTH_UPSTREAM };
      if (authInjection === 'provider-oauth') {
        return resolveProviderOAuthControlRouteDecision('codex', gatewayKey);
      }
      return null;
    }

    // ② 未显式选供应商 → 回落默认路由(decideCodexRoute,与未升级行为字节级一致)。
    const decision = decideCodexRoute({ model, authInjection, gatewayKey });
    // codex/ 折扣模型该走 gateway 换 key 但没配 key → null(passthrough), 上游大概率 401, 记一条诊断。
    if (decision === null && authInjection === 'oauth-bearer' && model
      && gatewayProviderIdForRewrittenModel(model) !== null && !gatewayKey) {
      log.warn('codex routing → gateway but no api key configured; passthrough (可能 401)', { model });
    }
    return decision;
  };
}

function createTransformRequestChain(
  frozenAuthInjection?: CodexProxyAuthInjection,
  execAdapter = createResponsesCustomToolFunctionAdapter(['exec']),
): RequestTransform[] {
  const execFunctionAdapterTransform: RequestTransform = (body, ctx) =>
    isPlainObject(body) && needsExecFunctionAdapter(body, ctx, frozenAuthInjection)
      ? execAdapter.adaptRequest(body, ctx.reqId)
      : null;
  execFunctionAdapterTransform.errorMode = 'reject-request';
  execFunctionAdapterTransform.onRequestSettled = (requestId) => {
    execAdapter.releaseResponse(requestId);
  };
  const transforms: RequestTransform[] = [
    createActiveStripTransform({
      controller: encryptedStripController,
      enabled: () => readSilentEncryptedRetrySettings().enabled,
      strip: stripEncryptedContentFromBody,
    }),
    createActiveStripTransform({
      controller: imageGenerationStripController,
      enabled: () => true,
      strip: stripImageGenerationItemsWithoutIdFromBody,
    }),

    // Guardian uses an isolated child thread. Resolve its parent business
    // session and select that session's real provider model before provider
    // compatibility transforms inspect the request.
    createProviderAwareGuardianReviewerTransform(frozenAuthInjection),
    // collab_spawn 的首个 HTTP 请求可能早于 thread/started / spawn item。强制路由
    // transform 先懒登记血缘，随后 instructions transform 才能在同一请求注入产品提示词。
    createForcedSubagentRequestTransform(),
    createCodexTransform(),
    createLockedSubagentExecGuardTransform(),
    createGatewayNativeWebSearchTransform(),
    // 必须先于 xAI/MiniMax 兼容改写:先把供应商绑定的历史项降级成标准 message，
    // 后续针对具体供应商的 input 归一化才能稳定处理。
    createCrossProviderCompactionCompatTransform(),
    // 必须在 compaction 降级之后:自定义 LiteLLM 别名首次 422 会激活本 strip,
    // 若先于降级跑,会把 compaction 当未知 type 丢掉,明文「早期上下文不可用」提示就没了。
    createActiveStripTransform({
      controller: xaiModelInputStripController,
      enabled: () => true,
      strip: sanitizeXaiModelInputFromBody,
    }),
    // Providers that explicitly lack Responses custom tools still accept ordinary
    // functions. Adapt before provider sanitizers, then restore custom_tool_call
    // events on the matching response stream.
    execFunctionAdapterTransform,
    createStrictGatewayHistoryCompatTransform(),
    // Gateway / LiteLLM / 自定义 grok 不走 xAI 订阅 transform，但仍必须在
    // ModelInput deserialize 前洗 input[]。订阅直连那条会再洗一次（幂等）。
    createXaiModelInputSanitizeTransform(),
    sanitizeDeepSeekV4CustomTools,
    createXaiResponsesCompatTransform(),
    createGatewayGrokResponsesCompatTransform(frozenAuthInjection),
    createByteDanceSeedResponsesCompatTransform(),
    createMiniMaxResponsesCompatTransform(),
    createProviderModelRewriteTransform(),
    // 视觉桥透明替换（层 A，Responses 格式）：controller 未注入时短路透传，零干扰；
    // 注入后把纯文本模型请求 input[] 里的 input_image 转成文字描述。放在 strip 之前与
    // Anthropic 链一致，避免未来 strip 扩展覆盖 Responses input_image 时吃掉图。
    buildVisionBridgeProxyTransform(log),
    stripNonAnthropicFields,
  ];
  if (process.env.XDT_CODEX_PROXY_DUMP_TRANSFORMED_BODY === '1') {
    transforms.push(createDumpTransform());
  }
  return transforms;
}

/**
 * threadId → 该 thread 最近一次转发的**实际出口 origin**。
 *
 * 「后端不可达」诊断要报的出站路径必须属于这次失败的请求。resolver 侧的快照按上游
 * origin 分桶,但光有 origin 不够:codex 的出口随会话选定的 provider 变(订阅直连
 * ChatGPT、网关、xAI、自定义供应商),多会话并发时「按时间戳挑最新」只是猜测,可能
 * 把另一个会话的判定报到本次故障上。这里在转发前记下每个 thread 的实际出口,诊断按
 * threadId 精确取。
 *
 * 记录点选在 routingTransform 外层而非 responseObserver:observer 要等响应回来才跑,
 * 而上游不可达时压根没有响应 —— 那恰恰是诊断最需要它的时刻。
 *
 * 另一个副产品:只有请求**真的经过本 loopback proxy** 时才会有记录。gateway-key
 * fallback 下 codexProxyActive=false、codex 直连 gateway,这个 transform 不跑,于是
 * 查不到映射、诊断退回通用文案 —— 而不是报一条本次根本没走过的陈旧路径。
 */
const codexThreadUpstreamOrigin = new Map<string, string>();
const CODEX_THREAD_UPSTREAM_MAX_ENTRIES = 256;

/**
 * 记录 thread 的出口 origin。两个调用点共用(routingTransform 包装层与 chat bridge
 * 分支),守卫集中在这里 —— 分散写必然有一处漏掉 'unknown' 排除或漏掉 try/catch。
 *
 * `selectedThreadIdFromHeaders` 对无 thread 的请求(典型: models-manager 的
 * `GET /models` 轮询)回落到字面量 'unknown';那不是一个 thread,记进去只会污染桶,
 * 而诊断永远是用真实 threadId 来查的。
 *
 * 任何异常一律吞掉:这是诊断旁路,绝不能反过来影响转发。
 */
function recordCodexThreadUpstreamForDiagnostics(
  threadId: string | undefined,
  upstream: string,
): void {
  try {
    if (!threadId || threadId === 'unknown') return;
    const origin = new URL(upstream).origin;
    if (
      codexThreadUpstreamOrigin.size >= CODEX_THREAD_UPSTREAM_MAX_ENTRIES
      && !codexThreadUpstreamOrigin.has(threadId)
    ) {
      codexThreadUpstreamOrigin.clear();
    }
    codexThreadUpstreamOrigin.set(threadId, origin);
  } catch {
    // 上游串解析不出 origin(或其它意外)→ 不记,转发照常。
  }
}

/** 诊断用:该 thread 最近一次转发的实际出口 origin;没有记录过 → null。 */
export function getCodexThreadUpstreamOrigin(threadId: string): string | null {
  return codexThreadUpstreamOrigin.get(threadId) ?? null;
}

/** @internal 单测用。 */
export function resetCodexThreadUpstreamForTest(): void {
  codexThreadUpstreamOrigin.clear();
}

/**
 * 给 routingTransform 包一层「记录本次实际出口」。刻意包在外层而不是往
 * createModelRoutingTransform 内部逐分支补:那里有六个以上 return(含一个返回
 * Promise 的 chat-bridge 分支),逐个补必漏。
 *
 * 记录异常一律吞掉 —— 这是诊断旁路,绝不能反过来影响转发。
 */
export function withCodexUpstreamRecording(
  inner: RoutingTransform,
  defaultUpstream: () => string,
): RoutingTransform {
  return (body, ctx) => {
    const result = inner(body, ctx);
    const record = (decision: RoutingDecision | null): RoutingDecision | null => {
      try {
        // localHandler 的上游在这一层**看不见**(它由产生 decision 的分支自己持有),
        // 所以这里跳过,由那些分支自行记录 —— chat bridge 就在它的 .then 里记了。
        // 注意:localHandler 不代表「不出网」(chat bridge 自己用 outboundFetch 打
        // route.routing.upstream),只代表「不走 compat-proxy 的转发层」。
        if (!decision?.localHandler) {
          recordCodexThreadUpstreamForDiagnostics(
            selectedThreadIdFromHeaders(ctx.headers),
            decision?.upstreamOverride ?? defaultUpstream(),
          );
        }
      } catch {
        // 诊断旁路:记录失败就不记,转发照常。
      }
      return decision;
    };
    return result instanceof Promise ? result.then(record) : record(result);
  };
}

function createCodexProxyHandle(
  frozenAuthInjection?: CodexProxyAuthInjection,
): Promise<ProxyHandle> {
  const execAdapter = createResponsesCustomToolFunctionAdapter(['exec']);
  return createAnthropicCompatProxy({
    // 默认上游 = gateway(含 /v1)；普通模型 + oauth 由 routingTransform 覆盖到 ChatGPT。
    upstream: () => buildCodexGatewayBaseUrl(),
    transformRequest: createTransformRequestChain(frozenAuthInjection, execAdapter),
    transformResponse: (ctx) => execAdapter.createResponseTransform(ctx.reqId, {
      contentType: ctx.responseHeaders['content-type'] ?? '',
      contentEncoding: ctx.responseHeaders['content-encoding'] ?? '',
    }),
    // 常规 session proxy 继续读取当前全局 spawn 形态；control-plane proxy 在创建时
    // 冻结自己的形态，两个 app-server 并行时不会互相改写路由。
    routingTransform: withCodexUpstreamRecording(
      createModelRoutingTransform(frozenAuthInjection),
      () => buildCodexGatewayBaseUrl(),
    ),
    responseObserver: composeResponseObservers(
      createCodexResponseObserver(),
      createProviderUpstreamErrorObserver({
        agent: 'codex',
        resolveUserProviderId: (requestHeaders) => {
          const sessionId = sessionIdFromHeaders(requestHeaders);
          return sessionId ? getUserProviderIdForSession(sessionId) : null;
        },
        resolveUserProviderName: (providerId) =>
          getActiveCatalog().providers.find((provider) => provider.id === providerId)?.name ?? null,
      }),
      createXaiProxyAuthInvalidationObserver(),
    ),
    maxRequestBodyBytes: CODEX_PROXY_MAX_REQUEST_BODY_BYTES,
    debugDumpRequestBody: process.env.XDT_PROXY_DUMP_REQUEST_BODY === '1',
    recoveryRules: [...CODEX_BODY_RECOVERY_RULES],
    logger: log,
    resolveOutboundProxy: resolveDesktopOutboundProxy,
    // 仅 resolveWebSocketUpstream 真正返回 OAuth 上游时生效。已成功走过 WS 的单个 thread
    // 在瞬时断网后由 Cindy 原地回探，不让 Codex 因握手失败把该 session 固定到 HTTP。
    retryProvenWebSocketUpgrades: true,
    /**
     * WS upgrade 的上游固定为 ChatGPT 订阅后端。
     *
     * 为什么可以固定: 只有订阅直连 provider(CODEX_OPENAI_COMPACT_PROVIDER_ID)打开了
     * supports_websockets, 网关 / xAI / 自定义供应商一律保持 false 且永不发出 upgrade
     * 请求 —— 所以任何进到这里的 upgrade 必然属于订阅直连路由, 上游是确定的, 不需要
     * 像 HTTP 路径那样按 model 推导(upgrade 也没有 body 可供推导)。
     *
     * 非 oauth-bearer 态返回 null → proxy 回 426 → codex 退回 HTTP transport:
     * 该 provider 只在 oauth spawn 时定义(见 buildCodexProxySpawnArgs), env-key /
     * provider-oauth 进程本不该有 upgrade 进来; 真收到就让它降级, 而不是拿一个凭据
     * 形态不匹配的连接去打订阅后端。
     *
     * WS 内首次命中 body recovery 错误后，maker-core 调 armCodexHttpRecovery 登记
     * thread；下一次 upgrade 在这里回 426，Codex 原生 transport 按 session 级稳定
     * 降到 HTTP，再由上面的 recoveryRules 清理并透明重试。没有实际命中过错误的
     * thread 不预扫描、不降级，继续保留原生 WS 容量体验。
     */
    resolveWebSocketUpstream: ({ headers }) => {
      if ((frozenAuthInjection ?? getCodexProxyAuthInjection()) !== 'oauth-bearer') return null;
      const threadId = selectedThreadIdFromHeaders(headers);
      const recoveryReason = httpRecoveryReasonByThread.get(threadId);
      if (recoveryReason) {
        log.info('codex websocket declined for HTTP body recovery', {
          threadId,
          reason: recoveryReason,
        });
        return null;
      }
      // 独立 Subagent Provider 需要 HTTP body transform，但父 thread 不需要。
      // bundled Codex 在每次 upgrade 都带 thread/session 身份，collab_spawn 还带
      // parent thread id；只拒绝确实命中路由快照的子 thread，426 会让该子会话
      // 自己降到 HTTP，不影响父 thread 的预热/复用 socket。
      const subagentRoute = subagentRouteForWebSocketUpgrade(headers);
      if (subagentRoute) {
        log.info('codex websocket declined for subagent HTTP routing', {
          threadId,
          providerId: subagentRoute.providerId,
          catalogModel: subagentRoute.catalogModel,
        });
        return null;
      }
      return CODEX_OAUTH_UPSTREAM;
    },
  });
}

/**
 * 启动本地 Codex prompt proxy。幂等 —— 重复调用直接返回已缓存状态。
 *
 * `_startPromise` 去重并发启动;`_handle` 为空时 getCodexProxyEndpoint()
 * 直接 fallback 到真上游 URL。
 */
export async function ensureCodexProxyReady(): Promise<void> {
  if (_handle) return;
  if (_startPromise) return _startPromise;

  const generation = _disposeGeneration;
  _startPromise = (async () => {
    try {
      const handle = await createCodexProxyHandle();
      if (generation !== _disposeGeneration) {
        await handle.dispose().catch((err) => {
          log.warn('codex proxy start raced with dispose; disposing fresh handle failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }
      _handle = handle;
      log.info('codex proxy ready', { url: _handle.url, upstream: buildCodexGatewayBaseUrl() });
    } catch (err) {
      _handle = null;
      log.error('codex proxy failed to start, falling back to direct upstream', {
        err: err instanceof Error ? err.message : String(err),
        fallbackEndpoint: buildCodexGatewayBaseUrl(),
      });
    } finally {
      _startPromise = null;
    }
  })();
  return _startPromise;
}

/**
 * 为一次独立 control-plane app-server 提供冻结鉴权形态的专用 proxy。
 * 它不读取也不改写 session host 的全局 auth injection；同形态可安全复用同一端口。
 */
export async function ensureCodexControlPlaneProxyReady(
  authInjection: CodexProxyAuthInjection,
): Promise<void> {
  if (_controlPlaneHandles.has(authInjection)) return;
  const existing = _controlPlaneStartPromises.get(authInjection);
  if (existing) return existing;

  const generation = _disposeGeneration;
  let start!: Promise<void>;
  start = (async () => {
    try {
      const handle = await createCodexProxyHandle(authInjection);
      if (generation !== _disposeGeneration) {
        await handle.dispose().catch((err) => {
          log.warn('codex control-plane proxy start raced with dispose', {
            authInjection,
            err: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }
      _controlPlaneHandles.set(authInjection, handle);
      log.info('codex control-plane proxy ready', {
        authInjection,
        url: handle.url,
        upstream: buildCodexGatewayBaseUrl(),
      });
    } catch (err) {
      _controlPlaneHandles.delete(authInjection);
      log.error('codex control-plane proxy failed to start', {
        authInjection,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (_controlPlaneStartPromises.get(authInjection) === start) {
        _controlPlaneStartPromises.delete(authInjection);
      }
    }
  })();
  _controlPlaneStartPromises.set(authInjection, start);
  return start;
}

export function isCodexControlPlaneProxyHandleReady(
  authInjection: CodexProxyAuthInjection,
): boolean {
  return _controlPlaneHandles.has(authInjection);
}

export function getCodexControlPlaneProxyEndpoint(
  authInjection: CodexProxyAuthInjection,
): string {
  const handle = _controlPlaneHandles.get(authInjection);
  if (handle) return handle.url;
  const fallbackEndpoint = buildCodexGatewayBaseUrl();
  log.warn('codex control-plane proxy not ready, falling back to direct gateway', {
    authInjection,
    fallbackEndpoint,
  });
  return fallbackEndpoint;
}

/**
 * 给 Codex app-server 用的 provider base_url —— 永远是 loopback proxy 的 root。
 *
 * codex 向 `${base_url}/responses` 发请求 → proxy 收 `/responses`。proxy 默认上游
 * buildCodexGatewayBaseUrl()(含 /v1)→ 拼成 `/v1/responses` 转 gateway;routingTransform override 到
 * CODEX_OAUTH_UPSTREAM(含 /backend-api/codex)→ 拼成 `/backend-api/codex/responses` 转 ChatGPT。
 * proxy 没起来 → fallback 到 gateway base_url(codex 直连 gateway, 失去 ChatGPT 透传, 但不裸奔)。
 */
export function getCodexProxyEndpoint(): string {
  if (_handle) return _handle.url;
  const fallbackEndpoint = buildCodexGatewayBaseUrl();
  log.warn('codex proxy not ready, falling back to direct gateway', { fallbackEndpoint });
  return fallbackEndpoint;
}

/**
 * 登记某个业务 session 当前 thread 对应的完整产品 prompt。
 *
 * 这是同步内存 Map 写入,不做 IO / 网络,调用方可以把它当成不可失败的强时序步骤。
 */
export function registerComposed(
  sessionId: string,
  threadId: string,
  text: string,
  opts: { subagentRoute?: CodexSubagentRouteSnapshot } = {},
): void {
  bindThreadToSession(sessionId, threadId);
  registry.set(threadId, text);
  const providerId = opts.subagentRoute?.providerId.trim();
  const catalogModel = opts.subagentRoute?.catalogModel.trim();
  if (providerId && catalogModel) {
    subagentRouteByParentThread.set(threadId, {
      providerId,
      catalogModel,
      reasoningEffort: opts.subagentRoute?.reasoningEffort ?? null,
    });
  } else {
    subagentRouteByParentThread.delete(threadId);
  }
  log.debug('registered codex prompt for thread', {
    sessionId,
    threadId,
    bytes: Buffer.byteLength(text, 'utf8'),
    registrySize: registry.size,
  });
}

function bindThreadToSession(sessionId: string, threadId: string): void {
  const previousThreadId = sessionToThread.get(sessionId);
  if (previousThreadId && previousThreadId !== threadId) {
    clearSessionThreads(sessionId);
  }

  const previousSessionId = threadToSession.get(threadId);
  if (previousSessionId && previousSessionId !== sessionId) {
    clearSessionThreads(previousSessionId);
  }

  sessionToThread.set(sessionId, threadId);
  const threads = sessionToThreads.get(sessionId) ?? new Set<string>();
  threads.add(threadId);
  sessionToThreads.set(sessionId, threads);
  threadToSession.set(threadId, sessionId);
}

/**
 * Register the exact parent-thread/session/model context required to route a
 * Guardian child request without consulting the shared app-server catalog.
 */
export function registerReviewerRouteContext(
  sessionId: string,
  threadId: string,
  model: string,
): boolean {
  const normalizedModel = model.trim();
  if (!sessionId || !threadId || !normalizedModel) return false;
  bindThreadToSession(sessionId, threadId);
  reviewerModelBySession.set(sessionId, normalizedModel);
  return true;
}

/**
 * 让 Codex 子 Agent thread 继承父 thread 的业务 session、桥接路由和产品 prompt。
 * app-server 的 thread/started 通知和子 thread 首个 collab_spawn 请求都可以
 * 幂等地调用这里，避免两者乱序时丢失路由。
 */
export function registerChildThread(parentThreadId: string, childThreadId: string): boolean {
  if (!parentThreadId || !childThreadId || parentThreadId === childThreadId) return false;

  const sessionId = threadToSession.get(parentThreadId);
  const text = registry.get(parentThreadId);
  if (!sessionId || text === undefined) {
    log.warn('cannot inherit codex child thread route from unknown parent', {
      parentThreadId,
      childThreadId,
    });
    return false;
  }

  const previousSessionId = threadToSession.get(childThreadId);
  if (previousSessionId && previousSessionId !== sessionId) {
    log.warn('refusing to overwrite codex child thread owned by another session', {
      parentThreadId,
      childThreadId,
      sessionId,
      previousSessionId,
    });
    return false;
  }

  const threads = sessionToThreads.get(sessionId) ?? new Set<string>();
  threads.add(childThreadId);
  sessionToThreads.set(sessionId, threads);
  threadToSession.set(childThreadId, sessionId);
  registry.set(childThreadId, text);
  const inheritedSubagentRoute =
    subagentRouteByThread.get(parentThreadId)
    ?? subagentRouteByParentThread.get(parentThreadId);
  if (inheritedSubagentRoute) {
    subagentRouteByThread.set(childThreadId, inheritedSubagentRoute);
  } else {
    subagentRouteByThread.delete(childThreadId);
  }
  log.debug('registered codex child thread route', {
    sessionId,
    parentThreadId,
    childThreadId,
    registrySize: registry.size,
  });
  return true;
}

function clearSessionThreads(sessionId: string): string[] {
  const threadIds = Array.from(sessionToThreads.get(sessionId) ?? []);
  sessionToThreads.delete(sessionId);
  sessionToThread.delete(sessionId);
  reviewerModelBySession.delete(sessionId);
  for (const threadId of threadIds) {
    if (threadToSession.get(threadId) === sessionId) {
      // Session 关闭既可能是普通释放，也可能是 OAuth ↔ 第三方模型的 route 切换。
      // 两种情况都必须撤销旧 thread 的 WS 成功证明：第三方恢复使用 cindy_gateway/HTTP，
      // 迟到的旧 upgrade 不能命中本次新增的 Cindy 侧 WS 保活；其他 thread 不受影响。
      _handle?.forgetWebSocketStateForThread?.(threadId);
      threadToSession.delete(threadId);
      registry.delete(threadId);
      subagentRouteByParentThread.delete(threadId);
      subagentRouteByThread.delete(threadId);
      httpRecoveryReasonByThread.delete(threadId);
    }
  }
  return threadIds;
}

/**
 * 清理业务 session 对应的 thread prompt。由后续 Layer 4 接到 onClose 调用。
 */
export function unregister(sessionId: string): void {
  const threadIds = clearSessionThreads(sessionId);
  if (threadIds.length === 0) return;

  log.debug('unregistered codex prompt for session', {
    sessionId,
    threadIds,
    registrySize: registry.size,
  });
}

/**
 * proxy handle 是否就绪(`_handle` 非空)。spawn 决策点用它**直接**判定 active,
 * 不要靠 `endpoint !== buildCodexGatewayBaseUrl()` 这类字符串比较——upstream / 常量
 * 任何一处加尾斜杠或改写都会让比较失真 → proxy 起不来却误判 active=true →
 * maker-core drop dev → 全员裸奔。这条路影响所有 API 用户,必须用显式就绪状态。
 */
export function isCodexProxyHandleReady(): boolean {
  return _handle !== null;
}

/**
 * 优雅关闭。注册到 bootstrap-electron 的 onQuit('async') 阶段。
 */
export async function disposeCodexProxy(): Promise<void> {
  _disposeGeneration += 1;
  dumpSeq = 0;
  for (const threadId of threadToSession.keys()) {
    registry.delete(threadId);
  }
  sessionToThread.clear();
  sessionToThreads.clear();
  threadToSession.clear();
  subagentRouteByParentThread.clear();
  subagentRouteByThread.clear();
  reviewerModelBySession.clear();
  httpRecoveryReasonByThread.clear();

  if (_startPromise) {
    await _startPromise.catch(() => undefined);
  }

  const h = _handle;
  _handle = null;

  if (_controlPlaneStartPromises.size > 0) {
    await Promise.allSettled(_controlPlaneStartPromises.values());
    _controlPlaneStartPromises.clear();
  }
  const controlPlaneHandles = Array.from(_controlPlaneHandles.values());
  _controlPlaneHandles.clear();

  if (h) {
    try {
      await h.dispose();
    } catch (err) {
      log.warn('codex proxy dispose failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }
  await Promise.all(controlPlaneHandles.map(async (handle) => {
    try {
      await handle.dispose();
    } catch (err) {
      log.warn('codex control-plane proxy dispose failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }));
}
