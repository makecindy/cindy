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
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { bindNativeProviderAuth, isNativeProviderAuthBound, unbindNativeProviderAuth } from './nativeProviderAuthBinding.js';

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
  getProviderSecretStore().remove(SECRET_ID);
  _blobCache = null;
  unbindNativeProviderAuth('xai');
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
    const res = await fetch(OIDC_DISCOVERY_URL, { signal });
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
    const res = await fetch(token, {
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

function isExpired(b: GrokTokenBlob): boolean {
  if (!b.expires_at) return false; // 无 expiry 信息 → 不主动刷,靠 401 暴露
  return Date.now() >= b.expires_at - REFRESH_MARGIN_SEC * 1000;
}

async function refreshIfNeeded(current: GrokTokenBlob): Promise<GrokTokenBlob> {
  if (!isExpired(current) || !current.refresh_token) return current;
  let result = current;
  const run = _refreshChain.then(async () => {
    const fresh = readBlob();
    if (fresh === null) {
      // 刷新期间用户已登出(blob 被清空)——不写回,让本次请求用旧 token 自然失败。
      result = current;
      return;
    }
    if (!isExpired(fresh)) {
      result = fresh;
      return;
    }
    const refreshToken = fresh.refresh_token;
    if (!refreshToken) {
      result = fresh;
      return;
    }
    // 刷新路径只需 token endpoint，直接用常量，避免 OIDC discovery fetch 挂起整条 _refreshChain。
    // 必须带超时:本 fetch 在 _refreshChain mutex 内,undici 默认 headersTimeout 5 分钟,
    // auth.x.ai 挂起会让所有排队的 xai/ 请求一起卡住;超时走 catch → 本次用旧 token。
    const res = await fetch(FALLBACK_TOKEN_URL, {
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
      log.warn('xai token 刷新失败', { status: res.status });
      result = fresh;
      return;
    }
    const tok = (await res.json()) as TokenResponse;
    if (!tok.access_token) {
      result = fresh;
      return;
    }
    const next = blobFromTokenResponse(tok, fresh);
    // 落盘前复核:刷新 fetch / res.json() 期间用户可能已登出(blob 被清)或已重登(blob 被改写)。
    // 清了 → 不回写(否则等于撤销 logoutGrok),本次用旧 token 自然失败;改了 → 以新登录状态为准,
    // 丢弃本次刷新结果。
    const beforeWrite = readBlob();
    if (beforeWrite === null) {
      result = fresh;
      return;
    }
    if (beforeWrite.refresh_token !== refreshToken) {
      result = beforeWrite;
      return;
    }
    writeBlob(next);
    result = next;
  });
  _refreshChain = run.catch(() => undefined);
  await run.catch((err) =>
    log.warn('xai token 刷新异常', { err: err instanceof Error ? err.message : String(err) }),
  );
  return result;
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
