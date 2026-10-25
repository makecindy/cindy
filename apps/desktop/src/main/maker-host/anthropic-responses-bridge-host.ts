import { createCodexCredentialRefresh, isCodexAccessTokenExpired, type CodexAuthFile } from '@cindy/model-providers/provider-auth/codex-credentials';
import { fastModelId, rewriteFastModel } from './model-fast-mode.js';
import { captureUsagePricing, createUsagePricingObserver } from './model-usage-pricing.js';
import type { ResponseObserverSink } from '@cindy/anthropic-compat-proxy';
import { getSessionFastMode } from './session-effort-store.js';
import { standardSpeedRequest } from '@cindy/maker-core';
import { subscriptionRequestAllowsFast } from './subscription-fast-request-policy.js';
import { isXaiSubscriptionProviderId } from './subscription-account-auth.js';
/**
 * Desktop 端 anthropic-responses-bridge 装配 ——
 *
 * 组装订阅直连 handler(**不是独立 server**):compat-proxy 的 routingTransform 在命中订阅
 * 前缀 model 时,把请求经 `RoutingDecision.localHandler` 直接交给本 handler(请求/响应双向
 * 协议翻译在 @cindy/anthropic-responses-bridge 内完成),消息流不多跳、无独立进程内服务。
 * 会话态(effort / Fast)由 routingTransform 在决策点闭包传入。
 *
 * 与独立 Codex CLI 授权链路的关系(硬约束:不得影响它):
 *   - 连接态以 codex auth adapter 为准(尊重登出与服务端失效标记),只**读** codex-home/auth.json
 *     的 access_token / 可选 account_id,不直接回落 ~/.codex(登出后系统 CLI 仍登录时不得继续用);
 *   - token 刷新是**兜底**:仅当 access_token 已过期且没有其它进程刚刷新时才自己刷,
 *     且写回用**原地 writeFile**(保留 inode,codex adapter 建的 ~/.codex 硬链继续同步,
 *     不会被 rename 破坏),mutex 串行 + 刷新前重读文件(app-server 刚刷过就直接用,不重复刷)。
 *   - 正常路径(用户平时也用 codex agent)由 codex app-server / CLI 保持 token 新鲜,bridge 只读。
 *
 * 失败兜底:handler 装配失败 → getResponsesBridgeHandler() 返 null,routingTransform 记 warn
 * 并 passthrough(该请求会 400/502,但不影响其它模型;摘掉路由分支即整体退回 fail-open)。
 */

import { app } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { zstdCompress, zstdDecompress } from 'node:zlib';

import {
  sanitizeXaiModelInputBody,
  type LocalRequestHandler,
} from '@cindy/anthropic-compat-proxy';
import { createResponsesHandler, type BridgeProviderConfig, type ResponsesBridgeHandler } from '@cindy/anthropic-responses-bridge';

import { createMakerLogger } from './logger-adapter.js';
import { getActiveCatalog } from './active-catalog.js';
import { outboundFetch } from './outbound-fetch.js';
import { getGrokAccessToken, peekGrokAccessToken } from './grok-oauth-login.js';
import { invalidateXaiBridgeAuth } from './xai-auth-invalidation-host.js';
import { chatgptAccountIdFromTokens, desktopCodexAuthAdapter } from './auth-adapters.js';
import { codexAccountHome, codexAccountState, invalidateCodexAccount, isOpenAiSubscriptionProviderId } from './codex-account-auth.js';
import {
  bearerAccessTokenFromHeaders,
  createChatgptBridgeAuthInvalidator,
} from './chatgpt-bridge-auth-invalidation.js';
import { buildChatgptBridgeHeaders } from './chatgpt-bridge-headers.js';
import { recordXaiRateLimitSnapshot } from '../usageBroadcaster.js';
import { xaiServerSideTools } from './xai-server-side-tools.js';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX } from '../../shared/subscriptionModels.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  OWNER_BOUNDARY_PENDING_ERROR,
  OwnerBoundaryPendingError,
  isOwnerBoundaryPendingError,
} from './owner-boundary-error.js';
import { describeErrorChain } from '../utils/errorChain.js';

const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);

const log = createMakerLogger('cc-bridge');

import { withNativeXaiServerSideTools } from '@cindy/model-providers/provider-auth/xai-native-tools';

let _handler: ResponsesBridgeHandler | null = null;
let _initialized = false;

function codexHomeAuthPath(): string {
  return path.join(app.getPath('userData'), 'codex-home', 'auth.json');
}

async function readAuthFile(authPath: string): Promise<CodexAuthFile | null> {
  try {
    return JSON.parse(await fsp.readFile(authPath, 'utf-8')) as CodexAuthFile;
  } catch {
    return null;
  }
}

const refreshIfNeeded = createCodexCredentialRefresh({
  read: readAuthFile,
  // Keep the shared native CLI inode, including existing auth hard links.
  write: async (authPath, value) => {
    await fsp.writeFile(authPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try { await fsp.chmod(authPath, 0o600); } catch { /* Windows */ }
  },
  fetch: outboundFetch,
  log,
});

// auth 结果短缓存 —— 一个 Claude turn 会发多个 API 请求,每请求都走「2×existsSync + readFile +
// JSON.parse + 2×JWT 解码」是 main event loop 上重复的同步/IO 浪费(规则 10)。token 未临期时
// 结果在几十秒内必然不变;临期(isExpired)时绕过缓存走完整刷新路径。外部进程(codex CLI)改写
// auth.json 最多延迟 AUTH_CACHE_TTL_MS 被看见,且只在旧 token 仍有效时发生,无正确性影响。
const AUTH_CACHE_TTL_MS = 30_000;
let _authCache: { accessToken: string; accountId: string | null; readAt: number } | null = null;

/**
 * 清除 ChatGPT bridge 凭证缓存。
 *
 * Codex(OpenAI)账号登录/登出/切换时调用 —— 旧缓存持有的 accessToken/accountId 已失效,
 * 下次请求必须重新读 auth.json 取最新凭证。
 */
export function clearChatgptBridgeCredentialCache(): void {
  _authCache = null;
}

const invalidateDefaultChatgptBridgeAuth = createChatgptBridgeAuthInvalidator({
  getCurrentAccessToken: () => desktopCodexAuthAdapter.getAccessToken(),
  invalidate: async (reason) => {
    clearChatgptBridgeCredentialCache();
    await desktopCodexAuthAdapter.invalidate(reason);
  },
});

export async function invalidateChatgptBridgeAuth(
  input: Parameters<typeof invalidateDefaultChatgptBridgeAuth>[0], providerId = 'openai',
): Promise<boolean> {
  if (providerId === 'openai') return invalidateDefaultChatgptBridgeAuth(input);
  const owner = activeOwnerScopeKey();
  return createChatgptBridgeAuthInvalidator({
    getCurrentAccessToken: () => desktopCodexAuthAdapter.getAccessToken(providerId),
    invalidate: async (reason) => {
      throwIfOwnerBoundDispatchUnsafe(owner);
      await invalidateCodexAccount(providerId, reason, input.failedAccessToken);
    },
  })(input);
}

function throwIfOwnerBoundDispatchUnsafe(scopeAtStart: string): void {
  if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scopeAtStart) {
    throw new OwnerBoundaryPendingError();
  }
}

/** 经 adapter 判连接态 → 读 codex-home/auth.json → 必要时刷新 → 返回 token 与可选 account id。 */
export async function getChatgptBridgeAuth(providerId = 'openai'): Promise<{ accessToken: string; accountId: string | null }> {
  const scopeAtStart = activeOwnerScopeKey();
  throwIfOwnerBoundDispatchUnsafe(scopeAtStart);
  if (providerId !== 'openai') {
    if (!codexAccountState(providerId).authenticated) throw new Error('OpenAI account is disconnected or requires login');
    const authPath = path.join(codexAccountHome(providerId), 'auth.json');
    const current = await readAuthFile(authPath);
    if (!current?.tokens?.access_token) throw new Error('OpenAI account credentials are unavailable');
    const refreshed = await refreshIfNeeded(authPath, current);
    throwIfOwnerBoundDispatchUnsafe(scopeAtStart);
    if (!codexAccountState(providerId).authenticated || !refreshed.tokens?.access_token) throw new Error('OpenAI account changed during authentication');
    return { accessToken: refreshed.tokens.access_token, accountId: chatgptAccountIdFromTokens(refreshed.tokens) };
  }
  const now = Date.now();
  if (_authCache && now - _authCache.readAt < AUTH_CACHE_TTL_MS && !isCodexAccessTokenExpired(_authCache.accessToken)) {
    throwIfOwnerBoundDispatchUnsafe(scopeAtStart);
    return _authCache;
  }
  // 连接态门:adapter 返回 null = 已登出 / 服务端已判失效(provider UI 显示未连接)。
  // bridge 必须与 UI 一致,不得自行回落 ~/.codex/auth.json —— 否则登出后系统 CLI 仍登录时,
  // chatgpt/ 请求会继续用被断开(甚至被判坏)的账号。非 null 时 adapter 的 reconcile 已保证
  // codex-home/auth.json 是权威文件(必要时从 ~/.codex 硬链),后续读写只针对它。
  const adapterToken = await desktopCodexAuthAdapter.getAccessToken();
  throwIfOwnerBoundDispatchUnsafe(scopeAtStart);
  if (adapterToken == null) {
    _authCache = null;
    throw new Error('OpenAI(ChatGPT 订阅)未连接或凭证已失效:请在「设置 → 模型供应商」登录');
  }
  const authPath = codexHomeAuthPath();
  let obj = await readAuthFile(authPath);
  throwIfOwnerBoundDispatchUnsafe(scopeAtStart);
  if (!obj?.tokens?.access_token) {
    _authCache = null;
    throw new Error('codex auth.json 无有效 access_token:请重新登录 OpenAI');
  }
  obj = await refreshIfNeeded(authPath, obj);
  throwIfOwnerBoundDispatchUnsafe(scopeAtStart);
  const accessToken = obj.tokens?.access_token;
  const accountId = chatgptAccountIdFromTokens(obj.tokens);
  if (!accessToken) {
    _authCache = null;
    throw new Error('codex auth.json 缺 access_token');
  }
  _authCache = { accessToken, accountId, readAt: now };
  return _authCache;
}

/** A deferred child request must revalidate both credential and authorization at dispatch/retry. */
export async function getChatgptBridgeAuthForDispatch(providerId = 'openai'): Promise<{
  accessToken: string; accountId: string | null; canDispatch(): boolean;
}> {
  const ownerScope = activeOwnerScopeKey();
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await getChatgptBridgeAuth(providerId);
    throwIfOwnerBoundDispatchUnsafe(ownerScope);
    const proof = desktopCodexAuthAdapter.captureOAuthDispatchProof(auth.accessToken, auth.accountId, providerId);
    if (proof) return {
      ...auth,
      canDispatch: () => ownerScope === activeOwnerScopeKey()
        && !isAppSessionBoundaryPending() && proof(),
    };
    // The existing cache can straddle native account replacement. Only a fresh,
    // proven credential may produce a new decision; the old decision stays invalid.
    clearChatgptBridgeCredentialCache();
  }
  throw new Error('OpenAI authorization changed while preparing the child request');
}

/** codex(ChatGPT 订阅)provider 配置:chatgpt/ 前缀 → codex 后端,注入订阅 OAuth + codex 专属头。 */
function codexProviderConfig(providerId = 'openai'): BridgeProviderConfig {
  return {
    prefix: CHATGPT_MODEL_PREFIX,
    wireProtocol: 'openai-responses',
    upstreamBase: 'https://chatgpt.com/backend-api/codex',
    // Fast 模式:codex models_cache 的 service_tiers 声明 {id:'priority', name:'Fast'},
    // handler 在 prefs.fast 时映射成 Responses 的 service_tier:'priority'。
    fastServiceTier: 'priority',
    supportedReasoningEfforts: (model) => getActiveCatalog().providers
      .find((provider) => provider.id === providerId)?.models['claude-code']
      ?.find((entry) => entry.id === `${CHATGPT_MODEL_PREFIX}${model}`)?.efforts,
    // codex 后端不支持 max_output_tokens(会 400),保持默认 false。
    buildHeaders: async ({ sessionId }) => {
      const { accessToken, accountId } = await getChatgptBridgeAuth(providerId);
      return buildChatgptBridgeHeaders({ accessToken, accountId, sessionId });
    },
    onUpstreamError: async ({ status, body, requestHeaders }) => {
      const failedAccessToken = bearerAccessTokenFromHeaders(requestHeaders);
      if (!failedAccessToken) return;
      await invalidateChatgptBridgeAuth({ status, body, failedAccessToken }, providerId);
    },
  };
}

/** xAI(SuperGrok 订阅)provider 配置:xai/ 前缀 → api.x.ai/v1,注入 Grok OAuth Bearer。 */
function xaiProviderConfig(providerId = 'xai'): BridgeProviderConfig {
  return {
    fastModel: model => fastModelId(providerId, 'claude-code', `xai/${model}`)?.replace(/^xai\//, ''),
    prefix: XAI_MODEL_PREFIX,
    wireProtocol: 'openai-responses',
    upstreamBase: 'https://api.x.ai/v1',
    // api.x.ai 是标准 Responses 实现,支持 max_output_tokens(codex 不支持)。
    maxOutputTokensSupported: true,
    // grok-code-fast / grok-build 系列不支持 reasoningEffort(实测 400),其余 grok 模型支持。
    supportsReasoning: (model) => !(model.startsWith('grok-code') || model.startsWith('grok-build')),
    // Grok 工具参数保真度不足(2026-08 实锤:单 session 16 次 Edit 缺 file_path 的 malformed
    // 重试风暴)。xAI 文档(docs.x.ai structured-outputs)称 tool calling 的 strict 隐式恒为
    // true,因此这里的显式声明预期是 no-op —— 保留它是意图声明 + 上游语义变化时的保护;
    // 真正承重的止损是 maker-core ToolLoopGuard 的契约错误层。逐工具兼容检查与回落由
    // bridge 层负责,不合规 schema(Edit 的可选 replace_all、复杂 MCP 关键字)保持 strict:false。
    strictFunctionTools: () => true,
    // Grok 的 X 实时视野来自 xAI 服务端工具 x_search:不声明就搜不了 X(见 xai-server-side-tools.ts)。
    serverSideTools: xaiServerSideTools,
    buildHeaders: async () => ({
      authorization: `Bearer ${await getGrokAccessToken(providerId)}`,
    }),
    // 周用量走 cli-chat-proxy billing,不在这条推理链上。这里只尽力抓 x-ratelimit-*
    // 作为 RPM/TPM 瞬时值;拿不到不影响账号周用量 chip。
    onRateLimit: (info, requestHeaders) => {
      const token = bearerAccessTokenFromHeaders(requestHeaders);
      if (!isAppSessionBoundaryPending() && token && token === peekGrokAccessToken(providerId)) recordXaiRateLimitSnapshot(info, providerId);
    },
    // 上游判定 OAuth 凭证失效时收口本地登录态。缺这一步的话:token 被服务端提前作废后
    // 本地 expires_at 仍未到期 → 永不刷新 → 每次请求都 403,而「设置 → 模型供应商」还
    // 一直显示已连接,用户没有任何线索该去重连。
    onUpstreamError: async ({ status, body, requestHeaders }) => {
      const failedAccessToken = bearerAccessTokenFromHeaders(requestHeaders);
      if (!failedAccessToken) return;
      await invalidateXaiBridgeAuth({ status, body, failedAccessToken }, providerId);
    },
  };
}

/**
 * 取订阅直连 handler(懒装配单例;纯内存组装,无 IO / 无端口绑定,无需启动阶段与优雅关闭)。
 * 装配失败(理论上仅配置错误,如未实现的 wireProtocol)→ 返 null 并记 ERROR,routingTransform
 * 据此 passthrough(fail-open),不反复重试刷日志。
 */
export function getResponsesBridgeHandler(providerId = 'openai'): ResponsesBridgeHandler | null {
  if (providerId !== 'xai' && isXaiSubscriptionProviderId(providerId)) {
    return createResponsesHandler({ providers: [xaiProviderConfig(providerId)], logger: log, fetchImpl: outboundFetch });
  }
  if (providerId !== 'openai' && providerId !== 'xai') {
    if (!isOpenAiSubscriptionProviderId(providerId)) return null;
    return createResponsesHandler({ providers: [codexProviderConfig(providerId), xaiProviderConfig()], logger: log, fetchImpl: outboundFetch });
  }
  if (_initialized) return _handler;
  _initialized = true;
  try {
    // 两个 provider 都注册;未登录的那个只在其请求到来时 buildHeaders 抛错(该请求 502),互不影响。
    _handler = createResponsesHandler({
      providers: [codexProviderConfig(), xaiProviderConfig()],
      logger: log,
      // 订阅直连的上游(chatgpt.com / api.x.ai)由 handler 自己发出,不经 compat-proxy
      // 的转发层,拿不到那边的出站代理;必须显式注入(见 outbound-fetch.ts)。
      fetchImpl: outboundFetch,
      // 一次性 Grok wire 归因取证开关;默认关闭,避免正常 agent 流量产生额外诊断日志。
      wireDiagnostics: process.env.XDT_WIRE_DIAGNOSTICS === '1',
      // dev-only strict spike(证据路径):生产控制面是上面 provider 配置的
      // strictFunctionTools,此开关只供诊断实例叠加验证,不得当生产开关用。
      wireDiagnosticsStrict: process.env.XDT_WIRE_DIAGNOSTICS_STRICT === '1',
    });
  } catch (err) {
    _handler = null;
    log.error('responses bridge handler 装配失败', { err: err instanceof Error ? err.message : String(err) });
  }
  return _handler;
}

type PiNativeSubscriptionProvider = string;
type PiNativeWireProtocol = 'openai-responses' | 'openai-chat';

interface PiNativeUpstream {
  url: string;
  wireProtocol: PiNativeWireProtocol;
}

export interface PiNativeSubscriptionHandlerDeps {
  fetch: typeof outboundFetch;
  getChatgptAuth: typeof getChatgptBridgeAuth;
  getGrokToken: typeof getGrokAccessToken;
  peekGrokToken: typeof peekGrokAccessToken;
  invalidateChatgpt: typeof invalidateChatgptBridgeAuth;
  invalidateXai: typeof invalidateXaiBridgeAuth;
  recordXaiRateLimit: typeof recordXaiRateLimitSnapshot;
}

const defaultPiNativeSubscriptionHandlerDeps: PiNativeSubscriptionHandlerDeps = {
  fetch: outboundFetch,
  getChatgptAuth: getChatgptBridgeAuth,
  getGrokToken: getGrokAccessToken,
  peekGrokToken: peekGrokAccessToken,
  invalidateChatgpt: invalidateChatgptBridgeAuth,
  invalidateXai: invalidateXaiBridgeAuth,
  recordXaiRateLimit: recordXaiRateLimitSnapshot,
};

function piNativeUpstream(
  providerId: PiNativeSubscriptionProvider,
  requestUrl: string,
): PiNativeUpstream | null {
  let pathname: string;
  try {
    pathname = new URL(requestUrl, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
  if (isOpenAiSubscriptionProviderId(providerId)) {
    return pathname === '/codex/responses'
      ? {
          url: 'https://chatgpt.com/backend-api/codex/responses',
          wireProtocol: 'openai-responses',
        }
      : null;
  }
  if (!isXaiSubscriptionProviderId(providerId)) return null;
  const normalized = pathname.startsWith('/v1/') ? pathname : `/v1${pathname}`;
  if (normalized === '/v1/responses') {
    return { url: `https://api.x.ai${normalized}`, wireProtocol: 'openai-responses' };
  }
  if (normalized === '/v1/chat/completions') {
    return { url: `https://api.x.ai${normalized}`, wireProtocol: 'openai-chat' };
  }
  return null;
}

function nativeResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      lower === 'content-type'
      || lower === 'cache-control'
      || lower === 'retry-after'
      || lower === 'x-request-id'
      || lower.startsWith('x-ratelimit-')
      || lower.startsWith('openai-')
    ) {
      headers[lower] = value;
    }
  });
  return headers;
}

function finiteRateLimitHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function recordNativeXaiRateLimit(
  headers: Headers,
  record: typeof recordXaiRateLimitSnapshot,
  providerId: string,
): void {
  const info = {
    limitRequests: finiteRateLimitHeader(headers, 'x-ratelimit-limit-requests'),
    remainingRequests: finiteRateLimitHeader(headers, 'x-ratelimit-remaining-requests'),
    limitTokens: finiteRateLimitHeader(headers, 'x-ratelimit-limit-tokens'),
    remainingTokens: finiteRateLimitHeader(headers, 'x-ratelimit-remaining-tokens'),
  };
  if (Object.values(info).some((value) => value !== undefined)) {
    record(info, providerId);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pi 用独立 `[1m]` 模型项承载上下文/压缩策略；ChatGPT 上游仍只接受官方裸 model id。 */
function withOpenaiContextProfileModel(body: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(body) || typeof body.model !== 'string' || !body.model.endsWith('[1m]')) {
    return null;
  }
  return { ...body, model: body.model.slice(0, -'[1m]'.length) };
}

async function rewriteOpenaiContextProfileRequest(
  rawBody: Buffer,
  parsedBody: unknown,
  contentEncoding: string | undefined,
): Promise<{ body: Buffer; contentEncoding: string | undefined } | null> {
  const parsedProfile = withOpenaiContextProfileModel(parsedBody);
  if (parsedProfile) {
    return { body: Buffer.from(JSON.stringify(parsedProfile)), contentEncoding: undefined };
  }
  if (parsedBody !== undefined || contentEncoding?.toLowerCase() !== 'zstd') return null;
  try {
    // Near-1M-token payloads are large enough to stall Electron main. Node's async
    // zstd APIs move compression work to the libuv worker pool.
    const decodedBody = await zstdDecompressAsync(rawBody);
    const decoded = JSON.parse(decodedBody.toString('utf8')) as unknown;
    const compressedProfile = withOpenaiContextProfileModel(decoded);
    if (!compressedProfile) return null;
    return {
      body: await zstdCompressAsync(Buffer.from(JSON.stringify(compressedProfile))),
      contentEncoding,
    };
  } catch {
    return null;
  }
}

function parseJsonRecord(rawBody: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function pipeNativeResponse(response: Response, res: Parameters<LocalRequestHandler>[0]['res'], observer?: ResponseObserverSink): Promise<void> {
  res.writeHead(response.status, nativeResponseHeaders(response));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (!res.destroyed) {
      const chunk = await reader.read();
      if (chunk.done) { observer?.onEnd?.(); break; }
      observer?.onData?.(Buffer.from(chunk.value));
      if (!res.write(Buffer.from(chunk.value))) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
        });
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!res.destroyed) res.end();
}

/**
 * Forward an already-native PI request. Unlike getResponsesBridgeHandler this
 * performs no Messages/Responses conversion: PI constructs the provider's
 * native payload, while the host swaps placeholder loopback credentials for
 * the connected account credential and restores xAI's model-gated server tools.
 */
export function getPiNativeSubscriptionHandler(
  providerId: PiNativeSubscriptionProvider,
  sessionId: string,
  deps: PiNativeSubscriptionHandlerDeps = defaultPiNativeSubscriptionHandlerDeps,
): LocalRequestHandler {
  return async ({ rawBody, parsedBody, ctx, res }) => {
    const upstream = piNativeUpstream(providerId, ctx.url);
    if (ctx.method !== 'POST' || !upstream) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'Unsupported PI subscription endpoint.' } }));
      return;
    }
    const controller = new AbortController();
    const abortOnClose = (): void => controller.abort();
    res.once('close', abortOnClose);
    const scopeAtStart = activeOwnerScopeKey();
    const fastAtStart = getSessionFastMode(sessionId);
    try {
      throwIfOwnerBoundDispatchUnsafe(scopeAtStart);
      let accessToken: string;
      let headers: Record<string, string>;
      if (isOpenAiSubscriptionProviderId(providerId)) {
        const auth = providerId === 'openai' ? await deps.getChatgptAuth() : await deps.getChatgptAuth(providerId);
        accessToken = auth.accessToken;
        headers = buildChatgptBridgeHeaders({
          accessToken,
          accountId: auth.accountId,
          sessionId,
        });
      } else {
        accessToken = providerId === 'xai' ? await deps.getGrokToken() : await deps.getGrokToken(providerId);
        headers = { authorization: `Bearer ${accessToken}` };
      }
      headers['content-type'] = ctx.headers['content-type'] ?? 'application/json';
      headers.accept = ctx.headers.accept ?? 'text/event-stream';
      let recordUsage: ReturnType<typeof captureUsagePricing> | undefined;
      let outboundBody = rawBody;
      let contentEncoding: string | undefined = ctx.headers['content-encoding'];
      if (isOpenAiSubscriptionProviderId(providerId)) {
        const rewritten = await rewriteOpenaiContextProfileRequest(
          rawBody,
          parsedBody,
          contentEncoding,
        );
        if (rewritten) {
          outboundBody = rewritten.body;
          contentEncoding = rewritten.contentEncoding;
        }
      } else if (isXaiSubscriptionProviderId(providerId)) {
        const parsed = isPlainRecord(parsedBody)
          ? parsedBody
          : parseJsonRecord(rawBody);
        const sanitized = parsed ? sanitizeXaiModelInputBody(parsed) : null;
        const withFast = parsed ? rewriteFastModel(providerId, 'pi', sanitized ?? parsed, fastAtStart) : null;
        const current = withFast ?? sanitized ?? parsed;
        recordUsage = captureUsagePricing(sessionId,
          withFast && withFast.model !== parsed?.model ? 'priority' : 'standard');
        const withServerTools = current
          ? withNativeXaiServerSideTools(current, upstream.wireProtocol)
          : null;
        if (sanitized || withFast || withServerTools) {
          outboundBody = Buffer.from(JSON.stringify(withServerTools ?? current));
          // The proxy parsed a plain JSON request. After reserializing it the
          // original content encoding, if any, no longer describes the bytes.
          contentEncoding = undefined;
        }
      }
      throwIfOwnerBoundDispatchUnsafe(scopeAtStart);
      if (contentEncoding) headers['content-encoding'] = contentEncoding;

      // Native Pi sends each tool-loop request here; recheck after auth/context awaits.
      if (isOpenAiSubscriptionProviderId(providerId) && !subscriptionRequestAllowsFast(sessionId, providerId)) {
        const bytes = contentEncoding?.toLowerCase() === 'zstd' ? await zstdDecompressAsync(outboundBody) : outboundBody;
        const standard = standardSpeedRequest(JSON.parse(bytes.toString('utf8')));
        outboundBody = Buffer.from(JSON.stringify(standard));
        delete headers['content-encoding'];
      }

      throwIfOwnerBoundDispatchUnsafe(scopeAtStart);
      const response = await deps.fetch(upstream.url, {
        method: 'POST',
        headers,
        body: new Uint8Array(outboundBody),
        signal: controller.signal,
      });
      if (isXaiSubscriptionProviderId(providerId) && response.ok && !isAppSessionBoundaryPending() && scopeAtStart === activeOwnerScopeKey()) {
        try {
          if (accessToken === deps.peekGrokToken(providerId)) recordNativeXaiRateLimit(response.headers, deps.recordXaiRateLimit, providerId);
        } catch { /* Display-only; never interrupt successful forwarding. */ }
      }
      if (!response.ok) {
        const errorBody = Buffer.from(await response.arrayBuffer());
        const errorText = errorBody.toString('utf8');
        if (isOpenAiSubscriptionProviderId(providerId)) {
          const failure = {
            status: response.status,
            body: errorText,
            failedAccessToken: accessToken,
          };
          if (providerId === 'openai') await deps.invalidateChatgpt(failure);
          else await deps.invalidateChatgpt(failure, providerId);
        } else {
          const failure = {
            status: response.status,
            body: errorText,
            failedAccessToken: accessToken,
          };
          if (providerId === 'xai') await deps.invalidateXai(failure);
          else await deps.invalidateXai(failure, providerId);
        }
        res.writeHead(response.status, nativeResponseHeaders(response));
        res.end(errorBody);
        return;
      }
      await pipeNativeResponse(response, res, recordUsage
        ? createUsagePricingObserver(response.headers.get('content-type') ?? '', recordUsage) : undefined);
    } catch (err) {
      if (controller.signal.aborted || res.destroyed) return;
      // Once a 200/SSE response has started, an upstream body failure cannot
      // be converted into a structured 502. Propagate it to runLocalHandler,
      // which destroys the client response so PI observes a transport failure
      // instead of accepting a cleanly-ended truncated stream.
      if (res.headersSent) throw err;
      if (isOwnerBoundaryPendingError(err)) {
        res.writeHead(503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': '1',
        });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'owner_boundary_pending',
            code: 'owner_boundary_pending',
            message: OWNER_BOUNDARY_PENDING_ERROR,
          },
        }));
        return;
      }
      const detail = describeErrorChain(err);
      const providerLabel = providerId === 'xai' ? 'xAI/Grok' : 'OpenAI/ChatGPT';
      log.warn('PI native subscription forwarding failed', {
        providerId,
        endpoint: upstream.url,
        wireProtocol: upstream.wireProtocol,
        requestPath: ctx.url,
        detail,
      });
      res.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({
        error: {
          type: 'upstream_error',
          provider: providerId,
          endpoint: upstream.url,
          message: `${providerLabel} upstream request failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      }));
    } finally {
      res.off('close', abortOnClose);
    }
  };
}
