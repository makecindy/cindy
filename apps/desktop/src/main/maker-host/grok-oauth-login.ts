/**
 * grok-oauth-login —— xAI(SuperGrok 订阅)OAuth 浏览器登录 + token 存储/刷新。
 *
 * 参数取自 xAI 的 grok-cli OAuth 公共配置(client_id / OIDC issuer / scope / 固定回调端口)。
 * 与 Claude 登录的关键差异:
 *   - 回调端口**固定 56121**(xAI 注册的 redirect_uri 是 http://127.0.0.1:56121/callback,不可随机);
 *   - code 由 consent 页(accounts.x.ai)的**页面 JS 跨源 fetch** 投递到 loopback(新版流程,
 *     不再 302 重定向)——回调服务器必须应答 CORS preflight + Chrome PNA 头,见 CallbackListener;
 *   - endpoints 走 OIDC discovery(auth.x.ai/.well-known/openid-configuration),校验必须在 *.x.ai over https;
 *   - token 交换是 **form-encoded**,且 PKCE 的 code_challenge/method 在交换时**再发一次**(该 client 会二次校验);
 *   - token 由**本模块自管**(存 safeStorage 的 provider secret 'xai',JSON blob),过期自己用 refresh_token 刷新
 *     ——没有 xAI 子进程替我们刷(不同于 Claude/codex 靠各自 CLI/子进程)。
 *
 * bridge(anthropic-responses-bridge-host)通过 getGrokAccessToken() 拿最新 access_token 注入
 * api.x.ai 请求头。
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { shell } from 'electron';

import { BRAND_NAME } from '@cindy/maker-shared/branding';

import {
  buildOAuthReturnAction,
  getProviderOAuthResultCopy,
  OAUTH_RESULT_HTML_LANG,
  pickOAuthResultPageLang,
  renderOAuthResultPage,
  type OAuthResultPageLang,
} from '../oauthResultPage.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { outboundFetch } from './outbound-fetch.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { bindNativeProviderAuth, isNativeProviderAuthBound, unbindNativeProviderAuth } from './nativeProviderAuthBinding.js';
import type { XaiBridgeAuthRecoveryOutcome } from './xai-bridge-auth-invalidation.js';

const log = desktopMakerLogger.child('grok-oauth-login');

// ── xAI OAuth 公共配置 ─────────────────────────────────────────────────────────
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const OIDC_DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration';
// discovery 失败时的兜底端点(已实测,与 discovery 返回一致)。
const FALLBACK_AUTHORIZE_URL = 'https://auth.x.ai/oauth2/authorize';
const FALLBACK_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
// xAI 注册的固定回调(不可改端口 / 主机)。
const REDIRECT_PORT = 56121;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** access_token 剩余寿命低于此(秒)就提前刷新。 */
const REFRESH_MARGIN_SEC = 120;
// token 刷新 fetch 超时 —— 刷新在 _refreshChain mutex 内串行,不设超时会拖住所有排队请求。
const REFRESH_FETCH_TIMEOUT_MS = 15_000;

const SECRET_ID = 'xai' as const;

// ── PKCE ──────────────────────────────────────────────────────────────────────
function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function genVerifier(): string {
  return base64URLEncode(randomBytes(32));
}
function genChallenge(verifier: string): string {
  return base64URLEncode(createHash('sha256').update(verifier).digest());
}
function genState(): string {
  return base64URLEncode(randomBytes(16));
}

// ── 存储 blob ───────────────────────────────────────────────────────────────────
interface GrokTokenBlob {
  access_token: string;
  refresh_token?: string;
  /** epoch ms;access_token 过期时刻(由 expires_in 换算)。 */
  expires_at?: number;
  obtained_at?: number;
  scope?: string;
}

// blob 内存缓存 —— safeStorage 解密是同步的 keychain/DPAPI 往返(每 xai 请求 + 每次
// listProviders 都读会反复阻塞 main event loop,规则 10)。凭证只经本模块读写,失效点精确:
// writeBlob / logoutGrok 时更新。undefined = 尚未从磁盘读过。
let _blobCache: GrokTokenBlob | null | undefined;

/** Drop the process-local xAI OAuth blob cache after an owner boundary. */
export function resetGrokOAuthMemoryCache(): void {
  _blobCache = undefined;
  _refreshChain = Promise.resolve();
  _lastForcedRefreshAt = 0;
}

function readBlob(): GrokTokenBlob | null {
  if (_blobCache !== undefined) return _blobCache;
  const raw = getProviderSecretStore().get(SECRET_ID);
  if (!raw) {
    _blobCache = null;
    return null;
  }
  try {
    const b = JSON.parse(raw) as GrokTokenBlob;
    _blobCache = typeof b.access_token === 'string' && b.access_token.length > 0 ? b : null;
  } catch {
    _blobCache = null;
  }
  return _blobCache;
}

function writeBlob(b: GrokTokenBlob): void {
  getProviderSecretStore().set(SECRET_ID, JSON.stringify(b));
  _blobCache = b;
}

/** 本机是否已登录 xAI(有可用 access_token)。供应商连接态用。 */
export function hasGrokOAuthLogin(): boolean {
  if (!isNativeProviderAuthBound('xai')) return false;
  return readBlob() !== null;
}

/** Legacy upgrade probe; only used while claiming the first verified owner. */
export function hasGrokOAuthLoginUnbound(): boolean {
  return readBlob() !== null;
}

/** 登出:清掉本机 xAI 凭证。 */
export function logoutGrok(): void {
  // remove() 的失败结果这里不阻断登出(用户意图优先),但正因为凭证可能没删掉,解绑必须
  // 带撤销标记 —— 否则下一次读连接态会把残留凭证自动认领回来(PR #548 review)。
  getProviderSecretStore().remove(SECRET_ID);
  _blobCache = null;
  // 冷却窗口跟着登录态走:重新登录后第一次被拒仍应立刻尝试自愈。
  _lastForcedRefreshAt = 0;
  unbindNativeProviderAuth('xai', { revoked: true });
}

// ── OIDC discovery(校验端点在 *.x.ai over https)────────────────────────────────
function assertXaiHttps(url: string, label: string): string {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !(u.hostname === 'x.ai' || u.hostname.endsWith('.x.ai'))) {
    throw new Error(`xAI OIDC ${label} 端点不可信: ${url}`);
  }
  return url;
}

async function resolveEndpoints(
  signal: AbortSignal,
): Promise<{ authorize: string; token: string }> {
  try {
    const res = await outboundFetch(OIDC_DISCOVERY_URL, { signal });
    if (res.ok) {
      const j = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string };
      if (j.authorization_endpoint && j.token_endpoint) {
        return {
          authorize: assertXaiHttps(j.authorization_endpoint, 'authorize'),
          token: assertXaiHttps(j.token_endpoint, 'token'),
        };
      }
    }
  } catch (err) {
    // 用户取消(abort)不算 discovery 失败:必须向上抛,否则登录流会继续开回调 server /
    // 拉浏览器,已取消的登录挂到超时才结束。
    if (signal.aborted) throw err instanceof Error ? err : new Error('login_cancelled');
    /* 其余错误落兜底端点 */
  }
  return { authorize: FALLBACK_AUTHORIZE_URL, token: FALLBACK_TOKEN_URL };
}

function buildAuthUrl(
  authorizeEndpoint: string,
  codeChallenge: string,
  state: string,
  nonce: string,
): string {
  const url = new URL(authorizeEndpoint);
  url.searchParams.append('response_type', 'code');
  url.searchParams.append('client_id', XAI_CLIENT_ID);
  url.searchParams.append('redirect_uri', REDIRECT_URI);
  url.searchParams.append('scope', SCOPE);
  url.searchParams.append('code_challenge', codeChallenge);
  url.searchParams.append('code_challenge_method', 'S256');
  url.searchParams.append('state', state);
  url.searchParams.append('nonce', nonce);
  url.searchParams.append('plan', 'generic');
  url.searchParams.append('referrer', 'xdt-maker');
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

/**
 * OIDC nonce 校验(Core 3.1.3.7):id_token 的 nonce claim 必须等于授权请求发出的 nonce,
 * 否则视为重放/注入,拒绝本次登录。上游未返 id_token / 解析失败 → 不拦(PKCE 已保护授权码,
 * nonce 是纵深防御;拿不到 claim 时无从比对,不能把正常登录误杀)。
 */
function verifyIdTokenNonce(idToken: string | undefined, expectedNonce: string): void {
  if (typeof idToken !== 'string' || !idToken) return;
  let claim: unknown;
  try {
    const part = idToken.split('.')[1];
    if (!part) return;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    claim = (JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as { nonce?: unknown }).nonce;
  } catch {
    return;
  }
  if (typeof claim === 'string' && claim !== expectedNonce) {
    throw new Error('id_token nonce 不匹配(疑似重放),已拒绝本次登录');
  }
}

/** 响应缺 expires_in 时的兜底 TTL —— 不能回填 prev.expires_at:刷新场景下旧值必然已在
 *  刷新边距内,会导致「每个请求都再刷一次 + refresh_token 每轮旋转」的自我打转。 */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

function blobFromTokenResponse(t: TokenResponse, prev?: GrokTokenBlob | null): GrokTokenBlob {
  const now = Date.now();
  return {
    access_token: t.access_token,
    // 刷新响应可能省略 refresh_token / scope → 沿用旧值;expires_at 绝不沿用(见上)。
    refresh_token: t.refresh_token ?? prev?.refresh_token,
    expires_at: now + (t.expires_in ? t.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS),
    obtained_at: now,
    scope: t.scope ?? prev?.scope,
  };
}

// ── 回调 CORS ──────────────────────────────────────────────────────────────────
// xAI 新版 consent 页(accounts.x.ai)授权完成后不再 302 重定向到 loopback,而是由
// 页面 JS 跨源 fetch 本回调地址投递 code(页面同时显示授权码供官方 CLI 手动粘贴兜底)。
// 跨源 fetch 要求本服务器正确应答 CORS preflight;Chrome 对「公网 https 页面 →
// 127.0.0.1」还要求 Private Network Access 头。来源只放行 xAI 自己的 auth 域。
const CALLBACK_CORS_ALLOWED_ORIGINS = new Set(['https://accounts.x.ai', 'https://auth.x.ai']);

/** origin 在白名单内时返回回调响应应附带的 CORS 头;否则为空(不放行)。 */
export function xaiCallbackCorsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !CALLBACK_CORS_ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  };
}

// ── 回调监听(固定端口 56121)────────────────────────────────────────────────────
// 导出仅供单测(runGrokOAuthLogin 是唯一运行期使用方)。
export class CallbackListener {
  private server: Server;
  private expectedState = '';
  /** code 已收到、等待 token exchange 收口的全部连接(consent 页可能重试 fetch)。 */
  private pending: Array<{ res: ServerResponse; cors: Record<string, string> }> = [];
  private callbackLang: OAuthResultPageLang = 'en';
  /**
   * 登录结果状态机,仅由 state 已匹配的回调驱动:收到 code → 'exchanging',
   * succeed()/fail() 收口为 'success'/'failed'(state 匹配的 error 回调直接
   * 'failed')。重放/迟到的回调按它回执:成功重放 200、失败重放 400、exchanging
   * 挂起同候(挂起连接在 fail() 时收 500)。state 不匹配的请求一律 400 拒绝,
   * 不进入状态机也不入 pending。
   */
  private outcome: 'exchanging' | 'success' | 'failed' | null = null;
  private resolve: ((code: string) => void) | null = null;
  private reject: ((err: Error) => void) | null = null;

  constructor() {
    this.server = createServer();
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', (err: NodeJS.ErrnoException) =>
        reject(
          new Error(
            err.code === 'EADDRINUSE'
              ? `xAI OAuth 回调端口 ${REDIRECT_PORT} 被占用(可能有其它 Grok 登录在跑),请关掉后重试`
              : `OAuth callback server failed: ${err.message}`,
          ),
        ),
      );
      // 必须监听固定端口 + 回环;xAI 只接受 http://127.0.0.1:56121/callback。
      this.server.listen(REDIRECT_PORT, '127.0.0.1', () => resolve());
    });
  }

  waitForCode(state: string): Promise<string> {
    this.expectedState = state;
    return new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.server.on('request', (req, res) => this.onRequest(req, res));
    });
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const cors = xaiCallbackCorsHeaders(
      typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
    );
    // CORS/PNA preflight 必须 204 放行且不触碰登录流状态 —— 它没有 code 参数,
    // 落进下方缺 code 分支会直接终止整个登录(issue #491 的卡死根因之一)。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const parsed = new URL(req.url || '', `http://127.0.0.1:${REDIRECT_PORT}`);
    if (parsed.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }
    const lang = pickOAuthResultPageLang(
      typeof req.headers['accept-language'] === 'string'
        ? req.headers['accept-language']
        : undefined,
    );
    this.callbackLang = lang;
    const copy = getProviderOAuthResultCopy(lang, 'xAI', BRAND_NAME);
    const action = buildOAuthReturnAction(lang, 'xai-oauth', BRAND_NAME);
    const code = parsed.searchParams.get('code') ?? undefined;
    const state = parsed.searchParams.get('state') ?? undefined;
    const oauthError =
      parsed.searchParams.get('error_description') ?? parsed.searchParams.get('error') ?? undefined;
    // state 是回调真实性的唯一凭证,最先校验。固定端口 + fetch 重试的新流程下,
    // 上一次登录尝试的 consent 页 tab 可能仍在带旧 state 重试 —— 凡 state 不匹配
    // 的请求(无论携带 code 还是 error、无论登录处于何种阶段)一律 400 拒绝:
    // 不 settle 当前登录(旧 tab 一次滞留重试不能杀死新发起的登录)、不入 pending
    // 挂起(否则不知道 state 的本机进程可在 exchange 窗口内囤积任意多连接)、
    // 不吃成功重放(避免旧 tab 白显成功)。
    if (state !== this.expectedState) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', ...cors });
      res.end(
        renderOAuthResultPage({
          htmlLang: OAUTH_RESULT_HTML_LANG[lang],
          variant: 'error',
          title: copy.errorTitle,
          body: copy.invalidStateBody,
          action,
        }),
      );
      return;
    }
    // 已有终态结果后网页侧可能重试 fetch(超时重发/用户手动访问)—— 不改写登录结果,
    // 按状态机回执:成功 200 / 失败 400;exchange 未收口时挂起同候(与首个连接一起在
    // succeed()/fail() 回执),不能提前发 200 —— exchange 随后失败会让页面白显成功。
    // 能走到这里的都已通过 state 校验,pending 只会积累同一 consent 页的合法重试。
    if (this.outcome !== null) {
      if (this.outcome === 'exchanging') {
        this.pending.push({ res, cors });
        return;
      }
      const replayStatus = this.outcome === 'success' ? 200 : 400;
      res.writeHead(replayStatus, { 'content-type': 'text/plain; charset=utf-8', ...cors });
      res.end(this.outcome === 'success' ? 'OK' : 'login failed');
      return;
    }
    if (!code) {
      // 无 code 也无 error:健康检查、预取等杂请求,回 400 但保持登录流继续等待,
      // 不能让任意本机请求终止一次进行中的登录。
      if (!oauthError) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', ...cors });
        res.end(
          renderOAuthResultPage({
            htmlLang: OAUTH_RESULT_HTML_LANG[lang],
            variant: 'error',
            title: copy.errorTitle,
            body: copy.missingCodeBody,
            action,
          }),
        );
        return;
      }
      // state 已匹配的 error 回调 = 当前这次授权被真实拒绝/失败,终止登录。
      this.outcome = 'failed';
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', ...cors });
      res.end(
        renderOAuthResultPage({
          htmlLang: OAUTH_RESULT_HTML_LANG[lang],
          variant: 'error',
          title: copy.errorTitle,
          body: copy.missingCodeBody,
          detail: oauthError,
          action,
        }),
      );
      this.reject?.(new Error('No authorization code received'));
      return;
    }
    this.outcome = 'exchanging';
    this.pending.push({ res, cors });
    this.resolve?.(code);
  }

  succeed(): void {
    this.outcome = 'success';
    const held = this.pending;
    this.pending = [];
    const copy = getProviderOAuthResultCopy(this.callbackLang, 'xAI', BRAND_NAME);
    for (const { res, cors } of held) {
      try {
        // 回执必须带上对应请求的 CORS 头:没有它,consent 页的 fetch 读不到响应,
        // 页面停在「等待检测」;302 导航场景 cors 为空对象,无影响。
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors });
        res.end(
          renderOAuthResultPage({
            htmlLang: OAUTH_RESULT_HTML_LANG[this.callbackLang],
            variant: 'success',
            title: copy.successTitle,
            body: copy.successBody,
            action: buildOAuthReturnAction(this.callbackLang, 'xai-oauth', BRAND_NAME),
          }),
        );
      } catch {
        // 连接可能已被客户端中止(如用户在 exchange 期间关掉授权页)——凭证此刻
        // 已成功落盘,单个回执通道抛错不得把成功登录翻转成失败(调用方在 catch
        // 里会返回 ok:false),也不得影响其余挂起连接的回执。
      }
    }
  }

  fail(detail?: string): void {
    // exchange 失败也是失败终态;code 尚未收到(pending 为空)时不改写 outcome,
    // 留给 onRequest 的分支自行定性。
    if (this.outcome === 'exchanging') this.outcome = 'failed';
    const held = this.pending;
    this.pending = [];
    for (const { res, cors } of held) {
      try {
        const copy = getProviderOAuthResultCopy(this.callbackLang, 'xAI', BRAND_NAME);
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8', ...cors });
        res.end(
          renderOAuthResultPage({
            htmlLang: OAUTH_RESULT_HTML_LANG[this.callbackLang],
            variant: 'error',
            title: copy.errorTitle,
            body: copy.exchangeFailedBody,
            detail,
            action: buildOAuthReturnAction(this.callbackLang, 'xai-oauth', BRAND_NAME),
          }),
        );
      } catch {
        /* 回执通道已关闭,登录结果仍由调用链决定 */
      }
    }
  }

  close(): void {
    if (this.pending.length > 0) {
      this.fail();
    }
    try {
      this.server.removeAllListeners();
      this.server.close();
    } catch {
      /* no-op */
    }
  }
}

let _currentListener: CallbackListener | null = null;
let _currentAbort: AbortController | null = null;

export interface GrokOAuthLoginResult {
  ok: boolean;
  reason?: string;
}

/** 跑一次 xAI 订阅 OAuth 浏览器登录。成功后把可刷新凭证写进 safeStorage('xai')。 */
export async function runGrokOAuthLogin(opts?: {
  onProgress?: (msg: string) => void;
}): Promise<GrokOAuthLoginResult> {
  cancelGrokOAuthLogin(); // 同一时刻只允许一个登录流

  const verifier = genVerifier();
  const challenge = genChallenge(verifier);
  const state = genState();
  const nonce = genState();
  const listener = new CallbackListener();
  const abort = new AbortController();
  _currentListener = listener;
  _currentAbort = abort;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const { authorize, token } = await resolveEndpoints(abort.signal);
    // resolveEndpoints 的 fetch 可被 abort,但 signal 可能在 await 返回后才被标记(race);
    // 显式检查避免在已取消状态下继续开回调 server 或开浏览器。
    if (abort.signal.aborted) throw new Error('login_cancelled');
    await listener.start();
    // listener.start() 同理:start 完成前取消会在后续 code-wait promise 被捕获,
    // 但 addEventListener 对已 aborted signal 不会再 fire —— 在此处提前检查保证不开浏览器。
    if (abort.signal.aborted) throw new Error('login_cancelled');
    const authUrl = buildAuthUrl(authorize, challenge, state, nonce);

    // 必须先注册 code 等待(挂上 server 的 request handler + 超时 + 取消),再开浏览器 ——
    // 已授权的浏览器可能在 openExternal 返回前就完成重定向,晚注册会丢掉那次回调请求,
    // 登录只能干等到超时。
    const codePromise = new Promise<string>((resolve, reject) => {
      if (abort.signal.aborted) {
        reject(new Error('login_cancelled'));
        return;
      }
      timer = setTimeout(() => reject(new Error('timeout')), LOGIN_TIMEOUT_MS);
      abort.signal.addEventListener('abort', () => reject(new Error('login_cancelled')), {
        once: true,
      });
      listener.waitForCode(state).then(resolve, reject);
    });
    // 预挂 no-op catch:openExternal 抛错走外层 catch 后,codePromise 稍后的 reject(超时/取消)
    // 不能变成 unhandled rejection;下方 await 仍能拿到同一 rejection,不受影响。
    codePromise.catch(() => {
      /* handled at await site */
    });

    opts?.onProgress?.('opening-browser');
    log.info('opening browser for xai oauth', { port: REDIRECT_PORT });
    await shell.openExternal(authUrl);

    const code = await codePromise;

    opts?.onProgress?.('exchanging');
    // form-encoded + PKCE 二次校验(challenge/method 再发一次)。
    const res = await outboundFetch(token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: XAI_CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString(),
      signal: abort.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Token exchange failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const tok = (await res.json()) as TokenResponse;
    if (!tok.access_token) throw new Error('token 响应缺 access_token');
    verifyIdTokenNonce(tok.id_token, nonce);

    // token exchange 的 fetch 带 signal,但 res.json() / nonce 校验期间到达的 abort
    // 不会中断已 resolve 的响应体 —— 落盘前最后检查,保证"已取消"的登录绝不写凭证。
    if (abort.signal.aborted) throw new Error('login_cancelled');
    writeBlob(blobFromTokenResponse(tok));
    bindNativeProviderAuth('xai');
    listener.succeed();
    log.info('xai oauth login success', { scope: tok.scope });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    listener.fail(msg);
    log.warn('xai oauth login failed', { error: msg });
    return { ok: false, reason: abort.signal.aborted ? 'login_cancelled' : msg };
  } finally {
    if (timer) clearTimeout(timer);
    listener.close();
    if (_currentListener === listener) _currentListener = null;
    if (_currentAbort === abort) _currentAbort = null;
  }
}

/** 取消进行中的 xAI 登录。 */
export function cancelGrokOAuthLogin(): void {
  _currentAbort?.abort();
  _currentListener?.close();
}

// ── token 刷新(bridge 每请求经 getGrokAccessToken 取用)────────────────────────
let _refreshChain: Promise<void> = Promise.resolve();

/** 被上游拒绝后强制刷新的冷却窗口(见 recoverGrokAuthAfterRejection 的说明)。 */
const FORCED_REFRESH_COOLDOWN_MS = 60_000;
let _lastForcedRefreshAt = 0;

function isExpired(b: GrokTokenBlob): boolean {
  // 无 expiry 信息 → 不主动刷;真失效时由上游 401/403 经 recoverGrokAuthAfterRejection 收口。
  if (!b.expires_at) return false;
  return Date.now() >= b.expires_at - REFRESH_MARGIN_SEC * 1000;
}

/**
 * 一次刷新尝试的结局。
 *
 * - `rejected` **专指**服务端以 OAuth `invalid_grant` 家族明确作废了 refresh_token;
 * - `unrecoverable` 是本地根本没有 refresh_token(请求都没发出去)—— 与 `rejected` 后果
 *   相同(只能重新登录),但成因完全不同,不能混成一个值,否则调用方会把「本地缺凭证」
 *   读成「服务端作废凭证」;
 * - 网络抖动、5xx、超时一律 `failed`,保留凭证。
 */
type GrokRefreshOutcome =
  | 'refreshed'
  | 'skipped'
  | 'superseded'
  | 'rejected'
  | 'unrecoverable'
  | 'failed';

interface GrokRefreshResult {
  blob: GrokTokenBlob;
  outcome: GrokRefreshOutcome;
}

/** 凭证库里的当前值是否仍是本次收口开始时那一份(access + refresh 都没被换过)。 */
function isSameCredential(current: GrokTokenBlob | null, attempted: GrokTokenBlob): boolean {
  return (
    current !== null
    && current.access_token === attempted.access_token
    && current.refresh_token === attempted.refresh_token
  );
}

/**
 * 服务端明确作废**用户凭证**的信号:再刷也不会好,只能重新登录。
 *
 * 只认 RFC 6749 §5.2 的结构化 `error` 码,不对整个响应体做子串匹配 —— `error_description`
 * 之类的自由文本里出现同样字样并不代表 refresh_token 被作废,上游改一句文案就把用户登出
 * 是不可接受的。非 JSON 或读不出 error 码时一律按临时失败处理(保留凭证)。
 *
 * 只认 invalid_grant 家族。刻意不认 invalid_client / unauthorized_client —— 那是 client
 * 注册侧的问题,把它当作废会在 xAI 调整 client 配置时把所有人一起登出,而重新登录同样失败。
 */
function isRefreshRejection(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  let code: unknown;
  try {
    code = (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    return false;
  }
  return code === 'invalid_grant' || code === 'invalid_token';
}

/**
 * 刷新 access_token。
 *
 * @param force 忽略本地 expires_at 直接刷。上游已经拒了当前 token 时必须强制:被服务端
 *   提前作废的 token 在本地看仍"没到期",不强制就永远刷不动 —— 这正是 403 长期无人
 *   收口时用户卡在「UI 显示已连接、请求连环失败」的根因。
 */
async function refreshBlob(current: GrokTokenBlob, force: boolean): Promise<GrokRefreshResult> {
  if (!force && !isExpired(current)) return { blob: current, outcome: 'skipped' };
  if (!current.refresh_token) {
    // 强制路径下没有 refresh_token = 无从自愈(请求都没发出去),交给调用方处理。
    return { blob: current, outcome: force ? 'unrecoverable' : 'skipped' };
  }
  // 下面的 catch 吞掉异常(超时 / 网络)时保留这个初值:强制路径当临时失败,不误杀凭证。
  let result: GrokRefreshResult = { blob: current, outcome: force ? 'failed' : 'skipped' };
  const run = _refreshChain.then(async () => {
    const fresh = readBlob();
    if (fresh === null) {
      // 刷新期间用户已登出(blob 被清空)——不写回,让本次请求用旧 token 自然失败。
      result = { blob: current, outcome: 'superseded' };
      return;
    }
    // 强制路径:其它请求或重新登录已经换过 token,本次失败关联的是旧凭证,不再消耗一次轮换。
    if (force && fresh.access_token !== current.access_token) {
      result = { blob: fresh, outcome: 'superseded' };
      return;
    }
    if (!force && !isExpired(fresh)) {
      result = { blob: fresh, outcome: 'skipped' };
      return;
    }
    const refreshToken = fresh.refresh_token;
    if (!refreshToken) {
      result = { blob: fresh, outcome: force ? 'unrecoverable' : 'skipped' };
      return;
    }
    // 刷新路径只需 token endpoint，直接用常量，避免 OIDC discovery fetch 挂起整条 _refreshChain。
    // 必须带超时:本 fetch 在 _refreshChain mutex 内,undici 默认 headersTimeout 5 分钟,
    // auth.x.ai 挂起会让所有排队的 xai/ 请求一起卡住;超时走 catch → 本次用旧 token。
    const res = await outboundFetch(FALLBACK_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: XAI_CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // body 只用于判定作废信号,不入日志 —— 错误响应可能回显授权材料。
      const body = await res.text().catch(() => '');
      const rejected = isRefreshRejection(res.status, body);
      log.warn('xai token 刷新失败', { status: res.status, rejected });
      if (rejected) {
        // 与成功路径同一道复核(见下方 beforeWrite):作废结论只对**发起本次刷新的那枚**
        // refresh_token 成立。fetch 期间用户可能已登出或重新登录 —— 此时凭证库里是另一枚
        // 全新的 refresh_token,拿旧的 invalid_grant 去 logoutGrok 会当场删掉刚建立的登录态。
        const currentBlob = readBlob();
        if (currentBlob === null || currentBlob.refresh_token !== refreshToken) {
          result = { blob: currentBlob ?? fresh, outcome: 'superseded' };
          return;
        }
      }
      result = { blob: fresh, outcome: rejected ? 'rejected' : 'failed' };
      return;
    }
    const tok = (await res.json()) as TokenResponse;
    if (!tok.access_token) {
      result = { blob: fresh, outcome: 'failed' };
      return;
    }
    const next = blobFromTokenResponse(tok, fresh);
    // 落盘前复核:刷新 fetch / res.json() 期间用户可能已登出(blob 被清)或已重登(blob 被改写)。
    // 清了 → 不回写(否则等于撤销 logoutGrok),本次用旧 token 自然失败;改了 → 以新登录状态为准,
    // 丢弃本次刷新结果。
    const beforeWrite = readBlob();
    if (beforeWrite === null) {
      result = { blob: fresh, outcome: 'superseded' };
      return;
    }
    if (beforeWrite.refresh_token !== refreshToken) {
      result = { blob: beforeWrite, outcome: 'superseded' };
      return;
    }
    writeBlob(next);
    result = { blob: next, outcome: 'refreshed' };
  });
  _refreshChain = run.catch(() => undefined);
  await run.catch((err) =>
    log.warn('xai token 刷新异常', { err: err instanceof Error ? err.message : String(err) }),
  );
  return result;
}

/** 到期才刷的常规路径(getGrokAccessToken 用);强制刷新走 refreshBlob(blob, true)。 */
async function refreshIfNeeded(current: GrokTokenBlob): Promise<GrokTokenBlob> {
  return (await refreshBlob(current, false)).blob;
}

/**
 * 取当前可用的 xAI access_token(过期则先刷新)。bridge 的 buildHeaders 调用。
 * 未登录 / 刷新后仍无 token → 抛错(bridge 据此回 502)。
 */
export async function getGrokAccessToken(): Promise<string> {
  if (!isNativeProviderAuthBound('xai')) {
    throw new Error('xAI OAuth is not bound to the active data owner');
  }
  const blob = readBlob();
  if (!blob) throw new Error('xAI 未登录:请先在「设置 → 模型供应商」登录 xAI(SuperGrok)');
  const fresh = await refreshIfNeeded(blob);
  if (!fresh.access_token) throw new Error('xAI access_token 不可用,请重新登录');
  return fresh.access_token;
}

/**
 * 只读当前 access_token:不刷新、不抛错、未登录返回 null。
 *
 * 失效收口用它把上游失败与「当时确实发出去的那把凭证」做等值关联 —— 换成
 * getGrokAccessToken 会顺带触发刷新,反而改变了要比对的状态。
 */
export function peekGrokAccessToken(): string | null {
  if (!isNativeProviderAuthBound('xai')) return null;
  return readBlob()?.access_token ?? null;
}

/**
 * 上游(api.x.ai)明确拒绝当前 access_token 后的凭证收口。
 *
 * xAI 没有子进程替我们维护凭证(见文件头注),而被服务端提前作废的 token 在本地
 * expires_at 上仍"没到期",常规刷新永远不会触发。所以这里强制刷一次:刷得动就自愈,
 * refresh_token 也被作废才登出。网络或临时失败保留登录态 —— 宁可下次再撞一次 403,
 * 也不要因为一次抖动把用户踢下线。
 *
 * @param rejectedAccessToken 上游拒掉的那把 access_token。**必须传**:invalidator 那边
 *   的等值检查到这里还隔着一次 await 边界,期间可能完成新登录或切换数据归属;不重新绑定
 *   就会拿新账号的凭证去承担旧 token 的失败,一个 invalid_grant 就能把新账号登出。
 */
export async function recoverGrokAuthAfterRejection(
  rejectedAccessToken: string,
): Promise<XaiBridgeAuthRecoveryOutcome> {
  // 与 getGrokAccessToken 同一道 owner 门:未绑定当前数据归属时不碰凭证。
  if (!isNativeProviderAuthBound('xai')) return 'superseded';
  const blob = readBlob();
  if (!blob) return 'superseded';
  // 重新绑定到被拒的那把 token(见 @param):不是同一把就说明这次失败已经与当前登录态无关。
  if (blob.access_token !== rejectedAccessToken) return 'superseded';
  // 冷却:同样是 401/403,也可能是订阅缺失、地域或模型未授权 —— 那种情况 token 本身有效,
  // 刷新永远"成功"却永远修不好,不设窗口就会每个请求刷一次,空耗 refresh_token 轮换,
  // 甚至撞上服务端的刷新复用检测。一个窗口只允许自愈一次,不行就让错误如实暴露给用户。
  const now = Date.now();
  if (now - _lastForcedRefreshAt < FORCED_REFRESH_COOLDOWN_MS) return 'unchanged';
  // 先占位再刷:并发进来的其它 token 不该同时发起强制刷新。
  const previousForcedRefreshAt = _lastForcedRefreshAt;
  _lastForcedRefreshAt = now;
  const { blob: attempted, outcome } = await refreshBlob(blob, true);
  switch (outcome) {
    case 'refreshed':
      log.info('xai access_token 被上游拒绝,已强制刷新恢复');
      return 'refreshed';
    case 'superseded':
      // superseded = 排队期间凭证已被换掉或清空,这次**根本没发起刷新**,占位要还回去:
      // 不还的话,紧接着被拒的那枚新 token 会被冷却挡住,最多 60s 无法自愈。
      // 仅在占位仍是自己写的时候回滚,避免覆盖期间另一次真实刷新的时间戳。
      if (_lastForcedRefreshAt === now) _lastForcedRefreshAt = previousForcedRefreshAt;
      return 'superseded';
    case 'rejected':
    case 'unrecoverable': {
      // 两者后果相同(只能重新登录),成因不同:rejected = 服务端作废 refresh_token;
      // unrecoverable = 本地压根没有 refresh_token,连请求都没发。
      //
      // refreshBlob 内部那道复核到这里还隔着两次 await 恢复(锁链 await + 本函数 await),
      // 足够让一次进行中的 OAuth 登录把新凭证写进来。删凭证是不可逆动作,登出前再复核一次:
      // 凭证已被换过就说明这个结论已经过期,按 superseded 放过。
      const currentBlob = readBlob();
      if (!isSameCredential(currentBlob, attempted)) return 'superseded';
      if (outcome === 'unrecoverable') {
        // 没发出请求,冷却还回去 —— 否则用户重登前的每次失败都白等一个窗口。
        if (_lastForcedRefreshAt === now) _lastForcedRefreshAt = previousForcedRefreshAt;
        log.warn('xai 凭证缺少 refresh_token,无从自愈,清空本机凭证并回落未登录');
      } else {
        // 冷却不回滚 —— 这一路确实发出了刷新请求,轮换已经消耗掉了。
        log.warn('xai refresh_token 已被服务端作废,清空本机凭证并回落未登录');
      }
      logoutGrok();
      return 'logged_out';
    }
    default:
      // failed / skipped:刷新没成功但也没有作废证据,保留凭证等下次。
      return 'unchanged';
  }
}
