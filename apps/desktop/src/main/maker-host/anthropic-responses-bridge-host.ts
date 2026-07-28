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

import { createResponsesHandler, type BridgeProviderConfig, type ResponsesBridgeHandler } from '@cindy/anthropic-responses-bridge';

import { createMakerLogger } from './logger-adapter.js';
import { outboundFetch } from './outbound-fetch.js';
import { getGrokAccessToken } from './grok-oauth-login.js';
import { invalidateXaiBridgeAuth } from './xai-auth-invalidation-host.js';
import { chatgptAccountIdFromIdToken, desktopCodexAuthAdapter } from './auth-adapters.js';
import {
  bearerAccessTokenFromHeaders,
  createChatgptBridgeAuthInvalidator,
} from './chatgpt-bridge-auth-invalidation.js';
import { buildChatgptBridgeHeaders } from './chatgpt-bridge-headers.js';
import { recordXaiRateLimitSnapshot } from '../usageBroadcaster.js';
import { xaiServerSideTools } from './xai-server-side-tools.js';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX } from '../../shared/subscriptionModels.js';

const log = createMakerLogger('cc-bridge');

/** Codex CLI 的 OAuth client_id(codex 登录用的同一个;refresh 走它)。取自 codex CLI prod 配置。 */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
/** access_token 剩余寿命低于此阈值就提前刷新(秒)。 */
const REFRESH_MARGIN_SEC = 120;
// token 刷新 fetch 超时 —— 刷新在 _refreshChain mutex 内串行,不设超时会拖住所有排队请求。
const REFRESH_FETCH_TIMEOUT_MS = 15_000;

let _handler: ResponsesBridgeHandler | null = null;
let _initialized = false;

interface CodexAuthFile {
  auth_mode?: string;
  last_refresh?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  [k: string]: unknown;
}

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

/** 解 JWT 的 exp 声明(秒)。解不出返回 null(视为不主动刷新,交给 401 兜底)。 */
function jwtExpSec(token: string | undefined): number | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp : null;
  } catch {
    return null;
  }
}

/** tokens.account_id 优先;回落解 id_token(复用 auth-adapters 的 claim 解析,单点维护)。 */
function accountIdFrom(tokens: NonNullable<CodexAuthFile['tokens']>): string | null {
  if (typeof tokens.account_id === 'string' && tokens.account_id.length > 0) return tokens.account_id;
  return typeof tokens.id_token === 'string' ? chatgptAccountIdFromIdToken(tokens.id_token) : null;
}

function isExpired(accessToken: string | undefined): boolean {
  const exp = jwtExpSec(accessToken);
  if (exp == null) return false; // 解不出 exp → 不主动刷,靠上游 401 暴露
  return Date.now() / 1000 >= exp - REFRESH_MARGIN_SEC;
}

// 刷新串行 mutex —— 防同一进程内并发请求同时打 refresh(会各自旋转 refresh_token 互相作废)。
let _refreshChain: Promise<void> = Promise.resolve();

/**
 * 兜底刷新:用 refresh_token + codex client_id 打 auth.openai.com/oauth/token,原地写回 auth.json。
 * mutex 串行 + 刷新前重读(app-server 刚刷过就直接用其结果,不重复消耗 refresh_token 旋转)。
 */
async function refreshIfNeeded(authPath: string, current: CodexAuthFile): Promise<CodexAuthFile> {
  if (!isExpired(current.tokens?.access_token)) return current;

  let result = current;
  const run = _refreshChain.then(async () => {
    // 重读:可能有别的进程(codex app-server)刚刷过。
    const fresh = await readAuthFile(authPath);
    if (fresh === null) {
      // 刷新期间 auth 文件被删除(用户已登出)——不重建,让本次请求用旧 token 自然失败。
      result = current;
      return;
    }
    if (!isExpired(fresh.tokens?.access_token)) {
      result = fresh;
      return;
    }
    const refreshToken = fresh.tokens?.refresh_token;
    if (!refreshToken) {
      log.warn('access_token 过期但无 refresh_token,无法刷新(请在设置里重新登录 OpenAI)');
      result = fresh;
      return;
    }
    log.info('bridge 兜底刷新 codex access_token', { last_refresh: fresh.last_refresh });
    // 必须带超时:本 fetch 在 _refreshChain mutex 内,undici 默认 headersTimeout 5 分钟,
    // auth.openai.com 挂起会让所有排队的 chatgpt/ 请求一起卡住。超时走 catch → 本次用旧 token。
    const res = await outboundFetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn('codex token 刷新失败', { status: res.status, body: (await res.text().catch(() => '')).slice(0, 300) });
      result = fresh;
      return;
    }
    const tok = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
    if (!tok.access_token) {
      log.warn('codex token 刷新响应缺 access_token');
      result = fresh;
      return;
    }
    const next: CodexAuthFile = {
      ...fresh,
      last_refresh: new Date().toISOString(),
      tokens: {
        ...fresh.tokens,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token ?? fresh.tokens?.refresh_token,
        id_token: tok.id_token ?? fresh.tokens?.id_token,
      },
    };
    // 落盘前复核:刷新 fetch / res.json() 期间用户可能已登出(文件被删)或已重登 / 他方进程
    // 已刷(文件被改写)。删了 → 不得用旧账号的刷新结果重建文件(否则等于撤销登出),本次用
    // 旧 token 自然失败(同上方 null 重读语义);改了 → 以磁盘新状态为准,丢弃本次刷新结果。
    const beforeWrite = await readAuthFile(authPath);
    if (beforeWrite === null) {
      result = fresh;
      return;
    }
    if (beforeWrite.tokens?.refresh_token !== refreshToken) {
      result = beforeWrite;
      return;
    }
    try {
      // 原地写(不 rename)—— 保留 inode,codex adapter 建的 ~/.codex 硬链继续与本文件同步。
      await fsp.writeFile(authPath, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
      try { await fsp.chmod(authPath, 0o600); } catch { /* Windows 无 chmod,忽略 */ }
    } catch (err) {
      log.warn('刷新后写回 auth.json 失败(本次仍用新 token,内存生效)', { err: err instanceof Error ? err.message : String(err) });
    }
    result = next;
  });
  // 把本次刷新接到链上(无论成败都释放锁给下一个)。
  _refreshChain = run.catch(() => undefined);
  await run.catch((err) => {
    log.warn('token 刷新异常', { err: err instanceof Error ? err.message : String(err) });
  });
  return result;
}

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

const invalidateChatgptBridgeAuth = createChatgptBridgeAuthInvalidator({
  getCurrentAccessToken: () => desktopCodexAuthAdapter.getAccessToken(),
  invalidate: async (reason) => {
    clearChatgptBridgeCredentialCache();
    await desktopCodexAuthAdapter.invalidate(reason);
  },
});

/** 经 adapter 判连接态 → 读 codex-home/auth.json → 必要时刷新 → 返回 token 与可选 account id。 */
export async function getChatgptBridgeAuth(): Promise<{ accessToken: string; accountId: string | null }> {
  const now = Date.now();
  if (_authCache && now - _authCache.readAt < AUTH_CACHE_TTL_MS && !isExpired(_authCache.accessToken)) {
    return _authCache;
  }
  // 连接态门:adapter 返回 null = 已登出 / 服务端已判失效(provider UI 显示未连接)。
  // bridge 必须与 UI 一致,不得自行回落 ~/.codex/auth.json —— 否则登出后系统 CLI 仍登录时,
  // chatgpt/ 请求会继续用被断开(甚至被判坏)的账号。非 null 时 adapter 的 reconcile 已保证
  // codex-home/auth.json 是权威文件(必要时从 ~/.codex 硬链),后续读写只针对它。
  const adapterToken = await desktopCodexAuthAdapter.getAccessToken();
  if (adapterToken == null) {
    _authCache = null;
    throw new Error('OpenAI(ChatGPT 订阅)未连接或凭证已失效:请在「设置 → 模型供应商」登录');
  }
  const authPath = codexHomeAuthPath();
  let obj = await readAuthFile(authPath);
  if (!obj?.tokens?.access_token) {
    _authCache = null;
    throw new Error('codex auth.json 无有效 access_token:请重新登录 OpenAI');
  }
  obj = await refreshIfNeeded(authPath, obj);
  const accessToken = obj.tokens?.access_token;
  const accountId = obj.tokens ? accountIdFrom(obj.tokens) : null;
  if (!accessToken) {
    _authCache = null;
    throw new Error('codex auth.json 缺 access_token');
  }
  _authCache = { accessToken, accountId, readAt: now };
  return _authCache;
}

/** codex(ChatGPT 订阅)provider 配置:chatgpt/ 前缀 → codex 后端,注入订阅 OAuth + codex 专属头。 */
function codexProviderConfig(): BridgeProviderConfig {
  return {
    prefix: CHATGPT_MODEL_PREFIX,
    wireProtocol: 'openai-responses',
    upstreamBase: 'https://chatgpt.com/backend-api/codex',
    // Fast 模式:codex models_cache 的 service_tiers 声明 {id:'priority', name:'Fast'},
    // handler 在 prefs.fast 时映射成 Responses 的 service_tier:'priority'。
    fastServiceTier: 'priority',
    // codex 后端不支持 max_output_tokens(会 400),保持默认 false。
    buildHeaders: async ({ sessionId }) => {
      const { accessToken, accountId } = await getChatgptBridgeAuth();
      return buildChatgptBridgeHeaders({ accessToken, accountId, sessionId });
    },
    onUpstreamError: async ({ status, body, requestHeaders }) => {
      const failedAccessToken = bearerAccessTokenFromHeaders(requestHeaders);
      if (!failedAccessToken) return;
      await invalidateChatgptBridgeAuth({ status, body, failedAccessToken });
    },
  };
}

/** xAI(SuperGrok 订阅)provider 配置:xai/ 前缀 → api.x.ai/v1,注入 Grok OAuth Bearer。 */
function xaiProviderConfig(): BridgeProviderConfig {
  return {
    prefix: XAI_MODEL_PREFIX,
    wireProtocol: 'openai-responses',
    upstreamBase: 'https://api.x.ai/v1',
    // api.x.ai 是标准 Responses 实现,支持 max_output_tokens(codex 不支持)。
    maxOutputTokensSupported: true,
    // grok-code-fast / grok-build 系列不支持 reasoningEffort(实测 400),其余 grok 模型支持。
    supportsReasoning: (model) => !(model.startsWith('grok-code') || model.startsWith('grok-build')),
    // Grok 的 X 实时视野来自 xAI 服务端工具 x_search:不声明就搜不了 X(见 xai-server-side-tools.ts)。
    serverSideTools: xaiServerSideTools,
    buildHeaders: async () => ({
      authorization: `Bearer ${await getGrokAccessToken()}`,
    }),
    // api.x.ai 无 ChatGPT 那种订阅窗口端点;尽力抓响应头 x-ratelimit-* 给底部 chip 展示,
    // 拿不到(上游不返头)则 renderer 诚实降级为仅价值估算。
    onRateLimit: (info) => recordXaiRateLimitSnapshot(info),
    // 上游判定 OAuth 凭证失效时收口本地登录态。缺这一步的话:token 被服务端提前作废后
    // 本地 expires_at 仍未到期 → 永不刷新 → 每次请求都 403,而「设置 → 模型供应商」还
    // 一直显示已连接,用户没有任何线索该去重连。
    onUpstreamError: async ({ status, body, requestHeaders }) => {
      const failedAccessToken = bearerAccessTokenFromHeaders(requestHeaders);
      if (!failedAccessToken) return;
      await invalidateXaiBridgeAuth({ status, body, failedAccessToken });
    },
  };
}

/**
 * 取订阅直连 handler(懒装配单例;纯内存组装,无 IO / 无端口绑定,无需启动阶段与优雅关闭)。
 * 装配失败(理论上仅配置错误,如未实现的 wireProtocol)→ 返 null 并记 ERROR,routingTransform
 * 据此 passthrough(fail-open),不反复重试刷日志。
 */
export function getResponsesBridgeHandler(): ResponsesBridgeHandler | null {
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
    });
  } catch (err) {
    _handler = null;
    log.error('responses bridge handler 装配失败', { err: err instanceof Error ? err.message : String(err) });
  }
  return _handler;
}
