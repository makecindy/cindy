/**
 * claude-oauth-login —— Claude.ai 订阅 OAuth 浏览器登录(忠实移植 cc-code services/oauth)。
 *
 * 为什么自己驱动而非调二进制:cc 没有 `codex login` 那种 headless 登录子命令
 * (`setup-token` / `/login` 都需要 TTY),agent SDK 也未公开 `claude_authenticate`。
 * 所以把 cc 的 OAuth 流程(PKCE + localhost 回调 + 浏览器 + token 交换)搬到 main 自己跑,
 * 拿到的完整可刷新凭证写进系统 ~/.claude 凭证库(claude-credentials-store),cc 子进程原生读取 + 自动刷新。
 *
 * 常量取自 cc-code constants/oauth.ts 的 **prod** 配置(client_id / authorize / token URL / scopes)。
 * 流程对齐 services/oauth/{index,client,auth-code-listener,crypto}.ts。
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { describeErrorChain } from '../utils/errorChain.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { outboundFetch } from './outbound-fetch.js';
import { writeClaudeAiOAuth } from './claude-credentials-store.js';
import { bindNativeProviderAuth } from './nativeProviderAuthBinding.js';
import { backfillClaudeSubscriptionProfile } from './claude-oauth-refresh.js';

const log = desktopMakerLogger.child('claude-oauth-login');

// ── prod OAuth 配置(对齐 cc constants/oauth.ts PROD_OAUTH_CONFIG) ──────────────
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// claude.ai 登录入口(307 跳到 claude.ai/oauth/authorize);用 claude.ai 流程(订阅用户)。
const CLAUDE_AI_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDEAI_SUCCESS_URL = 'https://platform.claude.com/oauth/code/success?app=claude-code';
const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference';
// ALL_OAUTH_SCOPES = union(CONSOLE, CLAUDE_AI),完整登录请求全 scope(含 user:inference)。
const ALL_OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// ── PKCE(对齐 crypto.ts) ─────────────────────────────────────────────────────
function base64URLEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function generateCodeVerifier(): string {
  return base64URLEncode(randomBytes(32));
}
function generateCodeChallenge(verifier: string): string {
  return base64URLEncode(createHash('sha256').update(verifier).digest());
}
function generateState(): string {
  return base64URLEncode(randomBytes(32));
}

function parseScopes(scopeString?: string): string[] {
  return scopeString?.split(' ').filter(Boolean) ?? [];
}

// 实现搬到 main/utils/errorChain.ts(device-link OSS 上传也要展开 undici 的
// 裸 'fetch failed');这里保留导出,原有调用方与单测的 import 路径不变。
export { describeErrorChain };

function buildAuthUrl(opts: { codeChallenge: string; state: string; port: number }): string {
  const url = new URL(CLAUDE_AI_AUTHORIZE_URL);
  url.searchParams.append('code', 'true'); // 让登录页展示 Claude Max upsell
  url.searchParams.append('client_id', CLIENT_ID);
  url.searchParams.append('response_type', 'code');
  url.searchParams.append('redirect_uri', `http://localhost:${opts.port}/callback`);
  url.searchParams.append('scope', ALL_OAUTH_SCOPES.join(' '));
  url.searchParams.append('code_challenge', opts.codeChallenge);
  url.searchParams.append('code_challenge_method', 'S256');
  url.searchParams.append('state', opts.state);
  return url.toString();
}

interface TokenExchangeResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function exchangeCodeForTokens(
  code: string,
  state: string,
  codeVerifier: string,
  port: number,
  signal: AbortSignal,
): Promise<TokenExchangeResponse> {
  // outboundFetch:换 token 是 main 自己发的 HTTPS 请求,不经浏览器。裸 undici fetch
  // 不吃系统代理,代理软件跑「系统代理」模式时授权页正常、这一步却直连出网,被上游按
  // 来源拒(实测 403)。
  const res = await outboundFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `http://localhost:${port}/callback`,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
      state,
    }),
    signal,
  });
  if (res.status !== 200) {
    throw new Error(
      res.status === 401
        ? 'Authentication failed: invalid authorization code'
        : `Token exchange failed (${res.status})`,
    );
  }
  return (await res.json()) as TokenExchangeResponse;
}

/**
 * localhost 回调监听(精简移植 auth-code-listener.ts)。捕获
 * `http://localhost:<port>/callback?code=...&state=...`,校验 state(CSRF),拿到 code 后把浏览器
 * 重定向到官方成功页。
 */
class CallbackListener {
  private server: Server;
  private port = 0;
  private expectedState = '';
  private pendingRes: ServerResponse | null = null;
  private callbackLang: OAuthResultPageLang = 'en';
  private resolve: ((code: string) => void) | null = null;
  private reject: ((err: Error) => void) | null = null;

  constructor() {
    this.server = createServer();
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', (err) =>
        reject(new Error(`OAuth callback server failed: ${err.message}`)),
      );
      this.server.listen(0, 'localhost', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  /** 等回调拿 code。state 校验失败 / 无 code → reject。 */
  waitForCode(state: string): Promise<string> {
    this.expectedState = state;
    return new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.server.on('request', (req: IncomingMessage, res: ServerResponse) =>
        this.onRequest(req, res),
      );
    });
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const parsed = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
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
    const copy = getProviderOAuthResultCopy(lang, 'Claude', BRAND_NAME);
    const action = buildOAuthReturnAction(lang, 'claude-oauth', BRAND_NAME);
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
    this.pendingRes = res; // 留到 token 交换成功后再 302 到成功页
    this.resolve?.(code);
  }

  /** code 交换成功后把浏览器重定向到官方成功页。 */
  redirectToSuccess(): void {
    if (!this.pendingRes) return;
    this.pendingRes.writeHead(302, { Location: CLAUDEAI_SUCCESS_URL });
    this.pendingRes.end();
    this.pendingRes = null;
  }

  fail(detail?: string): void {
    if (!this.pendingRes) return;
    try {
      const copy = getProviderOAuthResultCopy(this.callbackLang, 'Claude', BRAND_NAME);
      this.pendingRes.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      this.pendingRes.end(
        renderOAuthResultPage({
          htmlLang: OAUTH_RESULT_HTML_LANG[this.callbackLang],
          variant: 'error',
          title: copy.errorTitle,
          body: copy.exchangeFailedBody,
          detail,
          action: buildOAuthReturnAction(this.callbackLang, 'claude-oauth', BRAND_NAME),
        }),
      );
    } catch {
      /* 回执通道已关闭,登录结果仍由调用链决定 */
    }
    this.pendingRes = null;
  }

  close(): void {
    if (this.pendingRes) {
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

export interface ClaudeOAuthLoginResult {
  ok: boolean;
  /** 失败原因(reason)— 'login_cancelled' / 'timeout' / 具体错误信息。 */
  reason?: string;
}

/**
 * 跑一次 Claude.ai 订阅 OAuth 浏览器登录。成功后把完整可刷新凭证写入系统 ~/.claude 凭证库。
 * 幂等取消:cancelClaudeOAuthLogin() 会关监听 + abort 交换请求,让本函数以 login_cancelled 返回。
 */
export async function runClaudeOAuthLogin(opts?: {
  onProgress?: (msg: string) => void;
}): Promise<ClaudeOAuthLoginResult> {
  // 同一时刻只允许一个登录流;新登录前先取消旧的。
  cancelClaudeOAuthLogin();

  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();
  const listener = new CallbackListener();
  const abort = new AbortController();
  _currentListener = listener;
  _currentAbort = abort;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const port = await listener.start();
    const authUrl = buildAuthUrl({ codeChallenge: challenge, state, port });

    opts?.onProgress?.('opening-browser');
    log.info('opening browser for claude oauth', { port });
    await shell.openExternal(authUrl);

    // 等回调,带 5min 超时 + 取消。
    const code = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), LOGIN_TIMEOUT_MS);
      abort.signal.addEventListener('abort', () => reject(new Error('login_cancelled')), {
        once: true,
      });
      listener.waitForCode(state).then(resolve, reject);
    });

    opts?.onProgress?.('exchanging');
    const tokens = await exchangeCodeForTokens(code, state, verifier, port, abort.signal);
    const scopes = parseScopes(tokens.scope);

    if (!scopes.includes(CLAUDE_AI_INFERENCE_SCOPE)) {
      // 没拿到 inference scope = 不是订阅账号(或只授权了 Console),订阅模式用不了。
      listener.fail('not_a_subscription');
      return { ok: false, reason: 'not_a_subscription' };
    }

    // 取消窗口收口:token 交换是网络往返,期间用户可能已点取消(cancelClaudeOAuthLogin
    // abort 掉 controller)—— 写凭证前显式检查,取消了就不落盘,避免「用户已取消、
    // 账号却连上了」(review 2026-07-04 P2)。
    if (abort.signal.aborted) {
      return { ok: false, reason: 'login_cancelled' };
    }
    // 凭证立即落盘 + 立即跳成功页 —— 不 await profile(最长 10s RTT 不能挡在登录
    // 成功路径上,review P1)。订阅身份(subscriptionType / rateLimitTier)由
    // backfillClaudeSubscriptionProfile 后台补:cc >= 2.1.198 在 MANAGED_BY_HOST 下
    // 不读凭证库,旧的「cc 子进程 refresh 时自行补全」路径已失效,这些字段现由 host
    // 注入 env(auth-adapters);回填失败静默,首次刷新时再补。
    writeClaudeAiOAuth({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      scopes,
      subscriptionType: null,
      rateLimitTier: null,
    });
    bindNativeProviderAuth('anthropic');
    void backfillClaudeSubscriptionProfile(tokens.access_token).catch((e) =>
      log.warn('post-login subscription profile backfill failed', {
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    listener.redirectToSuccess();
    log.info('claude oauth login success', { scopes });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    listener.fail(msg);
    log.warn('claude oauth login failed', { error: describeErrorChain(err) });
    return { ok: false, reason: abort.signal.aborted ? 'login_cancelled' : msg };
  } finally {
    if (timer) clearTimeout(timer);
    listener.close();
    if (_currentListener === listener) _currentListener = null;
    if (_currentAbort === abort) _currentAbort = null;
  }
}

/** 取消进行中的登录(用户在浏览器授权流半路反悔时调)。 */
export function cancelClaudeOAuthLogin(): void {
  _currentAbort?.abort();
  _currentListener?.close();
}
