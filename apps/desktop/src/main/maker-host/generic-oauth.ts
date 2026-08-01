/**
 * generic-oauth —— 目录 `auth.oauth` 描述符驱动的通用 OAuth Runner。
 *
 * 把 grok-oauth-login.ts 的五件同构事泛化成 per-provider 实例：
 *   ① PKCE 授权页拉起（回环回调端口来自描述符，缺省随机高位端口）；
 *   ② 回调捕获（state 校验）；
 *   ③ form-encoded token 交换（按 RFC 7636 回发 PKCE verifier）；
 *   ④ 凭证 blob 存 safeStorage `provider_oauth_<id>`（IO 注入，见 providerSecretStore
 *      的 genericOAuthSecretIo）+ 内存缓存（路由热路径同步读，规则 10）；
 *   ⑤ 临期单飞刷新（per-provider mutex 链 + 15s 超时 + 登出/重登竞态复核）。
 *
 * 深度定制供应商（anthropic / openai / xai）**不走本模块**——它们没有目录描述符，
 * 保持各自 bespoke 实现。本模块新增供应商 = OSS 目录推一段 auth.oauth 数据。
 *
 * 可测试性：storage / fetch / 开浏览器 / 时钟全部可注入（`configureGenericOAuth`），
 * 默认实现由 host 启动期接线（createDesktopProviderService）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { AgentKind, OAuthProviderDescriptor } from '@cindy/model-providers';

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

const log = desktopMakerLogger.child('generic-oauth');

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** access_token 剩余寿命低于此(ms)就触发后台刷新。 */
const REFRESH_MARGIN_MS = 120_000;
/** 刷新 fetch 超时 —— 在 per-provider mutex 链内，必须有界。 */
const REFRESH_FETCH_TIMEOUT_MS = 15_000;
/** 授权码换 token 的 fetch 超时——没有它,tokenUrl 挂起会让登录 spinner 永久卡死(只能手动取消)。 */
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
/** 响应缺 expires_in 时的兜底 TTL（不能沿用旧 expires_at，防刷新自打转，同 grok）。 */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

// ── 注入点（默认 no-op，host 启动期接线；测试注入内存实现）──────────────────────
export interface GenericOAuthStorage {
  read(providerId: string): string | null;
  /**
   * 配置 mutation 前的严格快照读取：不存在返回 null；读取/解密失败必须抛错，
   * 不能像热路径 read 一样折叠成“无凭证”。
   */
  readStrict(providerId: string): string | null;
  write(providerId: string, value: string): boolean;
  remove(providerId: string): boolean;
}

interface GenericOAuthIo {
  storage: GenericOAuthStorage;
  fetchImpl: typeof fetch;
  /** 拉起系统浏览器（生产 = electron shell.openExternal）。 */
  openExternal: (url: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('login_cancelled'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('login_cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

let io: GenericOAuthIo = {
  storage: {
    read: () => null,
    readStrict: () => null,
    write: () => false,
    remove: () => true,
  },
  // 第三方 provider 的 token / device / refresh 端点多在境外,默认走吃系统代理的通道。
  fetchImpl: outboundFetch,
  openExternal: async () => {
    throw new Error('generic-oauth openExternal not configured');
  },
  now: Date.now,
  sleep: sleepWithAbort,
};

/** host 启动期 / 测试注入依赖（部分覆盖）。 */
export function configureGenericOAuth(partial: Partial<GenericOAuthIo>): void {
  io = { ...io, ...partial };
}

// ── PKCE 工具（同 grok）─────────────────────────────────────────────────────────
function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
const genVerifier = (): string => base64URLEncode(randomBytes(32));
const genChallenge = (v: string): string =>
  base64URLEncode(createHash('sha256').update(v).digest());
const genState = (): string => base64URLEncode(randomBytes(16));

// ── 凭证 blob ───────────────────────────────────────────────────────────────────
interface OAuthTokenBlob {
  access_token: string;
  refresh_token?: string;
  /** epoch ms。 */
  expires_at?: number;
  obtained_at?: number;
  scope?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function blobFromTokenResponse(t: TokenResponse, prev?: OAuthTokenBlob | null): OAuthTokenBlob {
  const now = io.now();
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? prev?.refresh_token,
    expires_at: now + (t.expires_in ? t.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS),
    obtained_at: now,
    scope: t.scope ?? prev?.scope,
  };
}

// blob 内存缓存（safeStorage 解密是同步 keychain/DPAPI 往返，路由热路径不能每请求读盘）。
// undefined = 尚未从磁盘读过；null = 确认无凭证。凭证只经本模块读写，失效点精确。
const blobCache = new Map<string, OAuthTokenBlob | null>();

function parseBlob(raw: string | null): OAuthTokenBlob | null {
  if (!raw) return null;
  try {
    const blob = JSON.parse(raw) as OAuthTokenBlob;
    return typeof blob.access_token === 'string' && blob.access_token.length > 0 ? blob : null;
  } catch {
    return null;
  }
}

function readBlob(providerId: string): OAuthTokenBlob | null {
  const cached = blobCache.get(providerId);
  if (cached !== undefined) return cached;
  const raw = io.storage.read(providerId);
  const blob = parseBlob(raw);
  blobCache.set(providerId, blob);
  return blob;
}

/**
 * 落盘凭证 blob 并同步内存缓存,返回落盘是否成功。
 * 落盘失败时**内存缓存仍更新**:刷新场景丢弃新 blob 更危险——IdP 可能已轮换
 * refresh_token,丢弃后缓存里的旧 refresh_token 立即失效,当场断链;由调用方
 * 按场景决策(登录硬失败并回滚内存态、刷新保留内存态只记 warn)。
 */
function writeBlob(providerId: string, b: OAuthTokenBlob): boolean {
  const persisted = io.storage.write(providerId, JSON.stringify(b));
  blobCache.set(providerId, b);
  return persisted;
}

/** 该供应商本机是否已登录（有 access_token）。连接态判定用。 */
export function hasGenericOAuthLogin(providerId: string): boolean {
  return readBlob(providerId) !== null;
}

/** 登出：持久凭证删除成功后才清缓存，失败时保持登录态并通知调用方。 */
export function logoutGenericOAuth(providerId: string): boolean {
  if (!io.storage.remove(providerId)) return false;
  blobCache.set(providerId, null);
  // 链上若有 in-flight 刷新也安全:doRefresh 落盘前会复核 blob 已清则不回写。
  refreshChains.delete(providerId);
  return true;
}

/**
 * 可回滚地删除凭证。配置写入与 safeStorage 无法组成同一个数据库事务，因此调用方在
 * 配置提交失败时必须用返回的闭包恢复旧 blob；成功提交后直接丢弃闭包即可。
 */
export function removeGenericOAuthCredentialsReversibly(
  providerId: string,
): (() => boolean) | null {
  let previousRaw: string | null;
  try {
    previousRaw = io.storage.readStrict(providerId);
  } catch (err) {
    log.warn('generic oauth 凭证严格快照失败，拒绝删除', {
      providerId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const durableBlob = parseBlob(previousRaw);
  // 已有文件却无法解析也不是“无凭证”。保留原始文件并中止 mutation，避免配置失败回滚时
  // 把坏/新版 blob 静默删掉；未来格式迁移仍有恢复机会。
  if (previousRaw !== null && !durableBlob) return null;
  const cachedBeforeDelete = blobCache.get(providerId);
  const cacheToRestore = cachedBeforeDelete ?? durableBlob;
  if (!logoutGenericOAuth(providerId)) return null;
  return () => {
    if (previousRaw !== null && !io.storage.write(providerId, previousRaw)) return false;
    if (cacheToRestore !== undefined) blobCache.set(providerId, cacheToRestore);
    else blobCache.delete(providerId);
    return true;
  };
}

/**
 * 清空全部内存缓存。生产用于「账号切换清空本机密钥」后失效缓存
 * （providerSecretStore 的 secretsClearedListener 接线），测试用于切换注入 storage。
 */
export function resetGenericOAuthMemoryCache(): void {
  blobCache.clear();
  refreshChains.clear();
}

function isExpiringSoon(b: OAuthTokenBlob): boolean {
  if (!b.expires_at) return false; // 无 expiry 信息 → 不主动刷，靠 401 暴露
  return io.now() >= b.expires_at - REFRESH_MARGIN_MS;
}

// ── 刷新（per-provider 单飞链，同 grok 的 _refreshChain 语义）──────────────────────
const refreshChains = new Map<string, Promise<void>>();

async function doRefresh(providerId: string, oauth: OAuthProviderDescriptor): Promise<void> {
  const fresh = readBlob(providerId);
  if (fresh === null || !isExpiringSoon(fresh) || !fresh.refresh_token) return;
  const refreshToken = fresh.refresh_token;
  let res: Response;
  try {
    res = await io.fetchImpl(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: oauth.clientId,
      }).toString(),
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn('generic oauth token 刷新请求失败', {
      providerId,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!res.ok) {
    log.warn('generic oauth token 刷新失败', { providerId, status: res.status });
    return;
  }
  let tok: TokenResponse;
  try {
    tok = (await res.json()) as TokenResponse;
  } catch {
    return;
  }
  if (!tok.access_token) return;
  // 落盘前复核（同 grok）：刷新期间用户可能已登出（blob 被清）或已重登（refresh_token 变了）。
  const beforeWrite = readBlob(providerId);
  if (beforeWrite === null || beforeWrite.refresh_token !== refreshToken) return;
  if (!writeBlob(providerId, blobFromTokenResponse(tok, beforeWrite))) {
    // 内存态已更新(本次会话可继续用新 token),只是重启后需重新登录。
    log.warn('generic oauth 刷新凭证落盘失败,仅内存态生效', { providerId });
  }
}

/** 单飞刷新：同 provider 的并发刷新排队串行，链头异常不断链。 */
export function refreshGenericOAuthIfNeeded(
  providerId: string,
  oauth: OAuthProviderDescriptor,
): Promise<void> {
  const prev = refreshChains.get(providerId) ?? Promise.resolve();
  const run = prev.then(() => doRefresh(providerId, oauth));
  refreshChains.set(
    providerId,
    run.catch((err) => {
      log.warn('generic oauth 刷新异常', {
        providerId,
        err: err instanceof Error ? err.message : String(err),
      });
    }),
  );
  return run;
}

/**
 * 路由热路径的**同步** token 读取（provider-route 的 oauthTokenReader 接线到这里）。
 * 读内存缓存；发现临期时**后台**触发单飞刷新（不阻塞本次路由——首个请求可能仍用旧
 * token，401 后下一请求即拿到新 token）。descriptor 由调用方现查目录传入。
 */
export function readCachedGenericOAuthAccessToken(
  providerId: string,
  oauth: OAuthProviderDescriptor | undefined,
): string | null {
  const blob = readBlob(providerId);
  if (!blob) return null;
  if (oauth && isExpiringSoon(blob) && blob.refresh_token) {
    void refreshGenericOAuthIfNeeded(providerId, oauth);
  }
  return blob.access_token;
}

// ── 登录流 ─────────────────────────────────────────────────────────────────────
/** 回环回调监听（端口来自描述符；缺省 0 = OS 随机分配）。 */
class CallbackListener {
  private server: Server;
  private expectedState = '';
  private pendingRes: ServerResponse | null = null;
  private callbackLang: OAuthResultPageLang = 'en';
  private resolve: ((code: string) => void) | null = null;
  private reject: ((err: Error) => void) | null = null;
  port = 0;

  constructor(private readonly providerName: string) {
    this.server = createServer();
  }

  async start(fixedPort: number | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', (err: NodeJS.ErrnoException) =>
        reject(
          new Error(
            err.code === 'EADDRINUSE'
              ? `OAuth 回调端口 ${fixedPort} 被占用，请关闭占用进程后重试`
              : `OAuth callback server failed: ${err.message}`,
          ),
        ),
      );
      this.server.listen(fixedPort ?? 0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : (fixedPort ?? 0);
        resolve();
      });
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
    const parsed = new URL(req.url || '', `http://127.0.0.1:${this.port}`);
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
    const copy = getProviderOAuthResultCopy(lang, this.providerName, BRAND_NAME);
    const action = buildOAuthReturnAction(lang, 'generic-oauth', BRAND_NAME);
    const code = parsed.searchParams.get('code') ?? undefined;
    const state = parsed.searchParams.get('state') ?? undefined;
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        renderOAuthResultPage({
          htmlLang: OAUTH_RESULT_HTML_LANG[lang],
          variant: 'error',
          title: copy.errorTitle,
          body: copy.missingCodeBody,
          detail:
            parsed.searchParams.get('error_description') ??
            parsed.searchParams.get('error') ??
            undefined,
          action,
        }),
      );
      this.reject?.(new Error('No authorization code received'));
      return;
    }
    if (state !== this.expectedState) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        renderOAuthResultPage({
          htmlLang: OAUTH_RESULT_HTML_LANG[lang],
          variant: 'error',
          title: copy.errorTitle,
          body: copy.invalidStateBody,
          action,
        }),
      );
      this.reject?.(new Error('Invalid state parameter'));
      return;
    }
    this.pendingRes = res;
    this.resolve?.(code);
  }

  succeed(providerName: string): void {
    if (!this.pendingRes) return;
    // 与 close() 同口径包 try/catch:用户重定向后立刻关标签页,writeHead/end 可能同步抛
    // (ERR_STREAM_DESTROYED 等)。此时凭证已落盘、登录已成功,回执页写失败绝不能把
    // 结果翻转成 { ok: false }(否则 UI 报失败但连接态又显示已连接,自相矛盾)。
    try {
      this.pendingRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const copy = getProviderOAuthResultCopy(this.callbackLang, providerName, BRAND_NAME);
      this.pendingRes.end(
        renderOAuthResultPage({
          htmlLang: OAUTH_RESULT_HTML_LANG[this.callbackLang],
          variant: 'success',
          title: copy.successTitle,
          body: copy.successBody,
          action: buildOAuthReturnAction(this.callbackLang, 'generic-oauth', BRAND_NAME),
        }),
      );
    } catch {
      /* 回执页写失败无害:登录结果以凭证落盘为准 */
    }
    this.pendingRes = null;
  }

  fail(detail?: string): void {
    if (!this.pendingRes) return;
    try {
      const copy = getProviderOAuthResultCopy(this.callbackLang, this.providerName, BRAND_NAME);
      this.pendingRes.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      this.pendingRes.end(
        renderOAuthResultPage({
          htmlLang: OAUTH_RESULT_HTML_LANG[this.callbackLang],
          variant: 'error',
          title: copy.errorTitle,
          body: copy.exchangeFailedBody,
          detail,
          action: buildOAuthReturnAction(this.callbackLang, 'generic-oauth', BRAND_NAME),
        }),
      );
    } catch {
      /* 回执通道已关闭,登录结果仍由调用链决定 */
    }
    this.pendingRes = null;
  }

  close(): void {
    if (this.pendingRes) {
      // 裸文本 done 消除(PR3,callback-pages-classification 页壳改造点 5):
      // code 已回但流程在 succeed/fail 前被终结(取消/超时)= 登录未完成,
      // 走 shared builder 的失败页(legacy visual),不再返回无品牌纯文本。
      try {
        const copy = getProviderOAuthResultCopy(this.callbackLang, this.providerName, BRAND_NAME);
        this.pendingRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        this.pendingRes.end(
          renderOAuthResultPage({
            htmlLang: OAUTH_RESULT_HTML_LANG[this.callbackLang],
            variant: 'error',
            title: copy.errorTitle,
            body: copy.exchangeFailedBody,
            action: buildOAuthReturnAction(this.callbackLang, 'generic-oauth', BRAND_NAME),
          }),
        );
      } catch {
        /* no-op */
      }
      this.pendingRes = null;
    }
    try {
      this.server.removeAllListeners();
      this.server.close();
    } catch {
      /* no-op */
    }
  }
}

export interface GenericOAuthLoginResult {
  ok: boolean;
  reason?: string;
}

export interface GenericOAuthDeviceCodeProgress {
  phase: 'device-code';
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
}

export interface GenericOAuthLoginOptions {
  onProgress?: (progress: GenericOAuthDeviceCodeProgress) => void;
  /**
   * 凭证成功落盘后交出一次竞态安全的回滚闭包。只有当前凭证仍是本次登录写入的 blob
   * 时才删除；若后续登录/刷新已换新则 no-op，避免迟到取消误删新凭证。
   */
  onCredentialPersisted?: (rollback: () => boolean) => void;
}

// 同一时刻每个 provider 只允许一个登录流。
const activeLogins = new Map<
  string,
  { abort: AbortController; close: () => void }
>();

/** 取消某供应商进行中的登录。 */
export function cancelGenericOAuthLogin(providerId: string): void {
  const cur = activeLogins.get(providerId);
  if (!cur) return;
  cur.abort.abort();
  cur.close();
  activeLogins.delete(providerId);
}

function safeVerificationUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = (await response.json()) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function runDeviceCodeGrant(
  providerId: string,
  oauth: Extract<OAuthProviderDescriptor, { flow: 'device-code' }>,
  abort: AbortController,
  options?: GenericOAuthLoginOptions,
): Promise<TokenResponse> {
  const requestBody = new URLSearchParams(oauth.extraDeviceParams ?? {});
  // 标准字段永远以描述符为准；即使未来有未经过目录校验的调用方也不能被 extras 覆盖。
  requestBody.set('client_id', oauth.clientId);
  requestBody.set('scope', oauth.scopes);
  const authorizationResponse = await io.fetchImpl(oauth.deviceAuthorizationUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: requestBody.toString(),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
  });
  const authorization = await readJsonObject(authorizationResponse);
  if (!authorizationResponse.ok) {
    throw new Error(`device_authorization_failed_${authorizationResponse.status}`);
  }

  const deviceCode =
    typeof authorization?.device_code === 'string' ? authorization.device_code : '';
  const userCode = typeof authorization?.user_code === 'string' ? authorization.user_code : '';
  const verificationUrl =
    safeVerificationUrl(authorization?.verification_uri_complete)
    ?? safeVerificationUrl(authorization?.verification_uri)
    ?? safeVerificationUrl(authorization?.verification_url);
  const expiresInSeconds = positiveNumber(authorization?.expires_in);
  if (!deviceCode || !userCode || !verificationUrl || !expiresInSeconds) {
    throw new Error('invalid_device_authorization_response');
  }

  const expiresInMs = expiresInSeconds * 1000;
  if (!Number.isFinite(expiresInMs)) {
    throw new Error('invalid_device_authorization_response');
  }
  // Device Authorization Grant 的有效期由 IdP 的 expires_in 决定；不能用授权码登录的
  // 五分钟回调超时截断，否则合法的 10–15 分钟设备码会在服务端仍有效时被本地提前判过期。
  const expiresAt = io.now() + expiresInMs;
  try {
    options?.onProgress?.({
      phase: 'device-code',
      verificationUrl,
      userCode,
      expiresAt,
    });
  } catch (err) {
    log.warn('generic oauth device-code progress callback failed', {
      providerId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let intervalMs = Math.min(
    Math.max((positiveNumber(authorization?.interval) ?? 5) * 1000, 1_000),
    60_000,
  );
  while (io.now() < expiresAt) {
    await io.sleep(Math.min(intervalMs, Math.max(0, expiresAt - io.now())), abort.signal);
    if (abort.signal.aborted) throw new Error('login_cancelled');

    const response = await io.fetchImpl(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: oauth.clientId,
      }).toString(),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
    });
    const payload = await readJsonObject(response);
    if (
      response.ok
      && typeof payload?.access_token === 'string'
      && payload.access_token.length > 0
    ) {
      return payload as unknown as TokenResponse;
    }

    const error = typeof payload?.error === 'string' ? payload.error : '';
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalMs = Math.min(intervalMs + 5_000, 60_000);
      continue;
    }
    if (error === 'access_denied') throw new Error('device_access_denied');
    if (error === 'expired_token') throw new Error('device_code_expired');
    throw new Error(
      error
        ? `device_token_error_${error}`
        : `device_token_exchange_failed_${response.status}`,
    );
  }
  throw new Error('device_code_expired');
}

/**
 * 跑一次描述符驱动的 OAuth 登录。支持浏览器回环 PKCE 与 Device Authorization Grant；
 * 成功后凭证 blob 写 safeStorage（provider_oauth_<id>）。
 */
export async function runGenericOAuthLogin(
  provider: { id: string; name: string },
  oauth: OAuthProviderDescriptor,
  options?: GenericOAuthLoginOptions,
): Promise<GenericOAuthLoginResult> {
  cancelGenericOAuthLogin(provider.id);

  const listener =
    oauth.flow === 'device-code' ? null : new CallbackListener(provider.name);
  const abort = new AbortController();
  activeLogins.set(provider.id, {
    abort,
    close: () => listener?.close(),
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    let tok: TokenResponse;
    if (oauth.flow === 'device-code') {
      tok = await runDeviceCodeGrant(provider.id, oauth, abort, options);
    } else {
      const verifier = genVerifier();
      const challenge = genChallenge(verifier);
      const state = genState();
      await listener!.start(oauth.redirectPort);
      if (abort.signal.aborted) throw new Error('login_cancelled');
      const redirectUri = `http://127.0.0.1:${listener!.port}/callback`;

      const authUrl = new URL(oauth.authorizeUrl);
      for (const [k, v] of Object.entries(oauth.extraAuthParams ?? {})) {
        authUrl.searchParams.append(k, v);
      }
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', oauth.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', oauth.scopes);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);

      // 先注册 code 等待再开浏览器（已授权的浏览器可能在 openExternal 返回前就完成重定向）。
      const codePromise = new Promise<string>((resolve, reject) => {
        if (abort.signal.aborted) {
          reject(new Error('login_cancelled'));
          return;
        }
        timer = setTimeout(() => reject(new Error('timeout')), LOGIN_TIMEOUT_MS);
        abort.signal.addEventListener('abort', () => reject(new Error('login_cancelled')), {
          once: true,
        });
        listener!.waitForCode(state).then(resolve, reject);
      });
      codePromise.catch(() => {
        /* handled at await site */
      });

      log.info('opening browser for generic oauth', {
        providerId: provider.id,
        port: listener!.port,
      });
      await io.openExternal(authUrl.toString());
      const code = await codePromise;

      const response = await io.fetchImpl(oauth.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: oauth.clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Token exchange failed (${response.status}): ${body.slice(0, 200)}`);
      }
      tok = (await response.json()) as TokenResponse;
      if (!tok.access_token) throw new Error('token 响应缺 access_token');
    }

    // 落盘前最后检查：已取消的登录绝不写凭证（同 grok）。
    if (abort.signal.aborted) throw new Error('login_cancelled');
    const persistedBlob = blobFromTokenResponse(tok);
    if (!writeBlob(provider.id, persistedBlob)) {
      // 落盘失败必须硬失败并回滚内存态:否则 UI 显示已连接、路由能用,重启/刷新后
      // 授权静默消失(safeStorage 不可用或 .enc 写不进磁盘的机器上尤其致命)。
      blobCache.set(provider.id, null);
      throw new Error('凭证写入本机安全存储失败,请检查系统钥匙串/加密服务后重试');
    }
    const persistedRaw = JSON.stringify(persistedBlob);
    options?.onCredentialPersisted?.(() => {
      let currentRaw: string | null;
      try {
        currentRaw = io.storage.readStrict(provider.id);
      } catch (err) {
        log.warn('generic oauth 取消回滚无法严格核对持久凭证', {
          providerId: provider.id,
          err: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      if (currentRaw !== persistedRaw) return true;
      return logoutGenericOAuth(provider.id);
    });
    listener?.succeed(provider.name);
    log.info('generic oauth login success', { providerId: provider.id, scope: tok.scope });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    listener?.fail(msg);
    log.warn('generic oauth login failed', { providerId: provider.id, error: msg });
    return { ok: false, reason: abort.signal.aborted ? 'login_cancelled' : msg };
  } finally {
    if (timer) clearTimeout(timer);
    listener?.close();
    if (activeLogins.get(provider.id)?.abort === abort) activeLogins.delete(provider.id);
  }
}

// ── 动态模型发现（additions-only，消费方 merge 进 active-catalog）───────────────────
/**
 * 由 runtime baseUrl 推导默认的模型发现端点（描述符未显式声明 modelsDiscoveryUrl 时用）。
 * 约定：Anthropic 兼容端点为 `{base}/v1/models`；OpenAI 兼容 baseUrl 常以 `/v1` 结尾，
 * 此时只追加 `/models`。自定义 OAuth 供应商靠这条推导免去用户手填发现端点。
 */
export function deriveModelsDiscoveryUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.hash = '';
  let pathname = url.pathname;
  while (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  url.pathname = /\/v\d+$/i.test(pathname)
    ? `${pathname}/models`
    : `${pathname === '/' ? '' : pathname}/v1/models`;
  return url.toString();
}

/**
 * 拉取 models 发现端点（带 Bearer），解析 OpenAI / Anthropic `GET /models` 形状
 * （`{data:[{id}]}` 或 `{models:[{id}]}` / 字符串数组）。失败返回 null（调用方保持纯静态兜底）。
 * 端点取 `discoveryUrl`（调用方按 runtime baseUrl 推导）?? 描述符显式声明的 modelsDiscoveryUrl。
 * `agent` 决定 wire 专属请求头：Anthropic wire（claude-code runtime）的**所有**端点
 * （含 GET /v1/models）都强制要求 `anthropic-version`，缺失直接 400 → 发现静默失败；
 * 与 provider-diagnostics.buildProbeRequest 的 cc 分支同口径。
 */
export async function discoverGenericOAuthModels(
  providerId: string,
  oauth: OAuthProviderDescriptor,
  discoveryUrl?: string,
  agent?: AgentKind,
): Promise<{ id: string; name: string; contextWindow?: number }[] | null> {
  const url = discoveryUrl ?? oauth.modelsDiscoveryUrl;
  if (!url) return null;
  const token = readCachedGenericOAuthAccessToken(providerId, oauth);
  if (!token) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (agent === 'claude-code') headers['anthropic-version'] = '2023-06-01';
  let res: Response;
  try {
    res = await io.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  return parseModelsListResponse(json);
}

/**
 * 解析 OpenAI / Anthropic「列模型」响应的三种形状（`{data:[{id}]}` / `{models:[{id}]}` /
 * 字符串数组）为去重后的 `{id, name, contextWindow?}[]`；无法识别返回 null。显示名优先取
 * 条目的 `display_name`（Anthropic 形状）/ `name` 字段，缺省回退 id。
 * contextWindow 尽力从常见字段读取（OpenRouter `context_length` / 通用 `context_window` /
 * Moonshot 等 `max_context_length` / Anthropic 兼容端点 `max_input_tokens`,与
 * model-discovery/anthropic.ts 认的字段对齐），无或非法时缺省——缺省的模型仍会
 * 回落保守默认(#386)。
 * 纯函数——OAuth 自动发现（本模块）与 API key 表单「获取模型列表」（provider-model-fetch）共用。
 */
export function parseModelsListResponse(
  json: unknown,
): { id: string; name: string; contextWindow?: number }[] | null {
  const list = (() => {
    if (!json || typeof json !== 'object') return null;
    const o = json as { data?: unknown; models?: unknown };
    if (Array.isArray(o.data)) return o.data;
    if (Array.isArray(o.models)) return o.models;
    return null;
  })();
  if (!list) return null;
  const out: { id: string; name: string; contextWindow?: number }[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const id =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
          ? (item as { id: string }).id
          : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rec =
      item && typeof item === 'object'
        ? (item as {
            display_name?: unknown;
            name?: unknown;
            context_length?: unknown;
            context_window?: unknown;
            max_context_length?: unknown;
            max_input_tokens?: unknown;
          })
        : null;
    const name =
      rec && typeof rec.display_name === 'string' && rec.display_name.length > 0
        ? rec.display_name
        : rec && typeof rec.name === 'string' && rec.name.length > 0
          ? rec.name
          : id;
    const rawWindow = rec
      ? [rec.context_length, rec.context_window, rec.max_context_length, rec.max_input_tokens].find(
          // Math.floor(v) > 0 而非 v > 0:0 < v < 1(如 context_length: 0.5)会通过
          // v > 0 但取整成 contextWindow: 0——按取整后的值校验才不会漏这个区间
          // (review P2)。Number.isSafeInteger(Math.floor(v)) 拒绝超出安全整数范围的
          // 异常值(如 context_length: 1e20)——这类值会通过取整后为正的校验,但落盘后
          // Main 的正数校验反而会因为超界而拒绝整份供应商配置,内置 OAuth 发现分支则会
          // 把这个失真值当真实窗口注入目录(review P2)。
          (v) => typeof v === 'number' && Number.isFinite(v) && Math.floor(v) > 0 && Number.isSafeInteger(Math.floor(v)),
        )
      : undefined;
    out.push({
      id,
      name,
      ...(typeof rawWindow === 'number' ? { contextWindow: Math.floor(rawWindow) } : {}),
    });
  }
  return out;
}
