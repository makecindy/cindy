/**
 * consoleHandoff.ts — Desktop → Web Console 一次性免登链接升级
 * ---------------------------------------------------------------------------
 * 当可信的桌面端主界面外链打开当前登录区域对应的 Console 页面时，由主进程静默向
 * `POST /api/auth/console-handoff` 换取 60 秒一次性 `#code=...` 中转链接再交给系统浏览器：
 * - 绝不在 renderer 暴露 handoff code，也绝不把 access/refresh token 写入 URL；
 * - 仅对可信应用页面触发（`isTrustedAppRendererEvent`）：
 *   - 组织身份会话使用当前 org access token 换发同组织 resource-only 免登；
 *   - 个人身份会话在本地持有 Passport 凭据时使用 account token 换发浏览器独立 account + resource 会话；
 * - 仅匹配当前活跃登录区域的 `authApiBaseUrl/console/*` 或该区域 `client-config` 声明的
 *   `consolePublicOrigin`，非本区/第三方链接零网络开销直接原样放行；
 * - 服务端超时、返回 404（旧服务端）、403 或异常链接时，一律静默回退原 URL。
 */
import { net } from 'electron';
import * as authManager from './authManager.js';
import { getClientEndpointForRealm } from './clientEndpointsService.js';
import { createLogger } from './logger.js';
import { serverApiFetch } from './serverApiClient.desktop.js';

const log = createLogger('consoleHandoff');

const HANDOFF_REQUEST_TIMEOUT_MS = 3_500;
const CLIENT_CONFIG_TIMEOUT_MS = 2_500;
const CLIENT_CONFIG_CACHE_TTL_MS = 5 * 60_000;
const MAX_TARGET_PATH_LENGTH = 2048;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const NON_RETURN_PREFIXES = [
  '/login',
  '/callback',
  '/handoff',
  '/support',
  '/subject-face',
] as const;

const UNIVERSAL_ORG_SECTIONS = new Set([
  'personal',
  'domains',
  'connections',
  'budgets',
  'members',
  'directory',
  'provisioning',
  'usage',
  'companyTokens',
  'analytics',
  'models',
  'cloud',
  'seats',
  'credits',
  'orders',
  'integrations',
  'skills',
  'bots',
  'plugins',
  'admins',
  'subject',
  'settings',
  'operationLogs',
]);

export type ConsoleHandoffEntry = 'console_prefix' | 'standalone';
export type ConsoleHandoffSessionMode = 'org' | 'account';

export interface MatchedConsoleTarget {
  targetPath: string;
  entry: ConsoleHandoffEntry;
}

export interface ConsoleHandoffDeps {
  trustedSender: boolean;
  getSessionMode: () => ConsoleHandoffSessionMode | null;
  isSessionCurrent?: () => boolean;
  getAuthBaseUrl: () => string | null;
  getConsolePublicOrigin?: (authBaseUrl: string) => Promise<string | null>;
  requestHandoff: (input: {
    authBaseUrl: string;
    targetPath: string;
    entry: ConsoleHandoffEntry;
    sessionMode: ConsoleHandoffSessionMode;
  }) => Promise<{ handoffUrl?: unknown } | null>;
  onFallback?: (reason: string) => void;
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function isAllowedConsoleOriginUrl(parsed: URL): boolean {
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
}

/**
 * 轻量同站提示：仅用于决定是否有必要查询一次 `client-config` 发现独立 Console 域名，
 * 避免点开 github.com 等普通外链时发多余请求。实际安全边界仍由 `client-config`
 * 返回的精确 `consolePublicOrigin` 匹配保证。
 */
export function sharesConsoleDiscoverySite(
  candidateHostname: string,
  authHostname: string,
): boolean {
  const candidate = candidateHostname.toLowerCase();
  const auth = authHostname.toLowerCase();
  if (candidate === auth) return true;
  if (isLoopbackHost(candidate) && isLoopbackHost(auth)) return true;
  const firstDot = auth.indexOf('.');
  if (firstDot <= 0) return false;
  const parentDomain = auth.slice(firstDot + 1);
  if (!parentDomain.includes('.')) return false;
  return candidate === parentDomain || candidate.endsWith(`.${parentDomain}`);
}

function isNonReturnPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === '/') return true;
  return NON_RETURN_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function hasControlOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

export function extractConsoleTargetPath(rawRelativePath: string): string | null {
  const trimmed = rawRelativePath.trim();
  if (!trimmed || trimmed === '/') return '/';
  if (trimmed.length > MAX_TARGET_PATH_LENGTH) return null;
  if (hasControlOrBackslash(trimmed)) return null;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, 'https://console.invalid');
  } catch {
    return null;
  }
  if (parsed.origin !== 'https://console.invalid') return null;
  parsed.searchParams.delete('view');

  if (parsed.pathname === '/') return '/';
  if (isNonReturnPath(parsed.pathname)) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '/';

  if (segments[0] === 'orgs') {
    if (!segments[1]) return null;
    let orgId: string;
    try {
      orgId = decodeURIComponent(segments[1]);
    } catch {
      return null;
    }
    if (!orgId) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  if (segments[0] === 'directory' && segments[1] === 'webhooks') return null;
  if (!UNIVERSAL_ORG_SECTIONS.has(segments[0]!)) return null;

  const normalizedPathname =
    segments.length === 1 && segments[0] === 'personal'
      ? '/personal/overview'
      : `/${segments.join('/')}`;
  return `${normalizedPathname}${parsed.search}${parsed.hash}`;
}

function parseAllowedOrigin(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!isAllowedConsoleOriginUrl(parsed)) return null;
  return parsed;
}

export function matchConsoleTarget(
  rawUrl: string,
  options: { authBaseUrl: string; consolePublicOrigin?: string | null },
): MatchedConsoleTarget | null {
  const parsed = parseAllowedOrigin(rawUrl);
  const authUrl = parseAllowedOrigin(options.authBaseUrl);
  if (!parsed || !authUrl) return null;

  if (parsed.origin === authUrl.origin) {
    if (parsed.pathname !== '/console' && !parsed.pathname.startsWith('/console/')) {
      return null;
    }
    const strippedPathname = parsed.pathname.slice('/console'.length) || '/';
    const targetPath = extractConsoleTargetPath(
      `${strippedPathname}${parsed.search}${parsed.hash}`,
    );
    return targetPath ? { targetPath, entry: 'console_prefix' } : null;
  }

  const consoleUrl = parseAllowedOrigin(options.consolePublicOrigin);
  if (consoleUrl && parsed.origin === consoleUrl.origin) {
    const targetPath = extractConsoleTargetPath(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    return targetPath ? { targetPath, entry: 'standalone' } : null;
  }

  return null;
}

export function validateConsoleHandoffUrl(
  rawHandoffUrl: unknown,
  options: { authBaseUrl: string; consolePublicOrigin?: string | null },
): string | null {
  if (typeof rawHandoffUrl !== 'string' || !rawHandoffUrl.trim()) return null;
  const parsed = parseAllowedOrigin(rawHandoffUrl);
  const authUrl = parseAllowedOrigin(options.authBaseUrl);
  if (!parsed || !authUrl) return null;
  if (parsed.search !== '') return null;

  const consoleUrl = parseAllowedOrigin(options.consolePublicOrigin);
  const matchesPrefixEntry =
    parsed.origin === authUrl.origin && parsed.pathname === '/console/handoff';
  const matchesStandaloneEntry =
    consoleUrl !== null && parsed.origin === consoleUrl.origin && parsed.pathname === '/handoff';
  if (!matchesPrefixEntry && !matchesStandaloneEntry) return null;

  const rawFragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : '';
  const code = new URLSearchParams(rawFragment).get('code')?.trim() ?? '';
  if (code.length < 16) return null;

  return rawHandoffUrl;
}

export async function resolveConsoleExternalUrl(
  rawUrl: string,
  deps: ConsoleHandoffDeps,
): Promise<string> {
  if (!deps.trustedSender) {
    return rawUrl;
  }
  const sessionMode = deps.getSessionMode();
  if (!sessionMode) {
    return rawUrl;
  }

  const authBaseUrl = deps.getAuthBaseUrl()?.trim() ?? '';
  const authUrl = parseAllowedOrigin(authBaseUrl);
  const parsedTarget = parseAllowedOrigin(rawUrl);
  if (!authUrl || !parsedTarget) {
    return rawUrl;
  }

  let consolePublicOrigin: string | null = null;
  let matched = matchConsoleTarget(rawUrl, {
    authBaseUrl: authUrl.origin,
    consolePublicOrigin: null,
  });

  if (
    !matched &&
    deps.getConsolePublicOrigin &&
    sharesConsoleDiscoverySite(parsedTarget.hostname, authUrl.hostname)
  ) {
    try {
      const discovered = await deps.getConsolePublicOrigin(authUrl.origin);
      const parsedConsole = parseAllowedOrigin(discovered);
      consolePublicOrigin = parsedConsole ? parsedConsole.origin : null;
    } catch {
      consolePublicOrigin = null;
    }
    if (consolePublicOrigin) {
      matched = matchConsoleTarget(rawUrl, {
        authBaseUrl: authUrl.origin,
        consolePublicOrigin,
      });
    }
  }

  if (!matched) {
    return rawUrl;
  }

  if (deps.isSessionCurrent && !deps.isSessionCurrent()) {
    deps.onFallback?.('session_changed');
    return rawUrl;
  }

  try {
    const response = await deps.requestHandoff({
      authBaseUrl: authUrl.origin,
      targetPath: matched.targetPath,
      entry: matched.entry,
      sessionMode,
    });
    if (deps.isSessionCurrent && !deps.isSessionCurrent()) {
      deps.onFallback?.('session_changed');
      return rawUrl;
    }
    const safeHandoffUrl = validateConsoleHandoffUrl(response?.handoffUrl, {
      authBaseUrl: authUrl.origin,
      consolePublicOrigin,
    });
    if (safeHandoffUrl) {
      return safeHandoffUrl;
    }
    deps.onFallback?.('invalid_handoff_url');
  } catch {
    deps.onFallback?.('request_failed');
  }

  return rawUrl;
}

interface CachedConsoleOrigin {
  origin: string | null;
  expiresAt: number;
}

const consoleOriginCache = new Map<string, CachedConsoleOrigin>();

/** Bound the browser-open path without cancelling a shared Passport refresh. */
export async function withConsoleHandoffDeadline(
  pending: Promise<string>,
  fallbackUrl: string,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(fallbackUrl), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchConsolePublicOrigin(authBaseUrl: string): Promise<string | null> {
  const normalizedBase = authBaseUrl.replace(/\/+$/, '');
  const now = Date.now();
  const cached = consoleOriginCache.get(normalizedBase);
  if (cached && cached.expiresAt > now) {
    return cached.origin;
  }

  const response = await net.fetch(`${normalizedBase}/api/auth/client-config`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(CLIENT_CONFIG_TIMEOUT_MS),
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as {
    consolePublicOrigin?: unknown;
  } | null;
  const parsedOrigin =
    typeof payload?.consolePublicOrigin === 'string'
      ? (parseAllowedOrigin(payload.consolePublicOrigin)?.origin ?? null)
      : null;

  consoleOriginCache.set(normalizedBase, {
    origin: parsedOrigin,
    expiresAt: now + CLIENT_CONFIG_CACHE_TTL_MS,
  });
  return parsedOrigin;
}

export async function resolveConsoleExternalUrlForDesktop(
  rawUrl: string,
  trustedSender: boolean,
): Promise<string> {
  const initialToken = authManager.getAccessToken();
  const initialState = authManager.getAuthState();
  const initialRealm = authManager.getActiveAuthRealm();
  const passportSession =
    initialState.user?.membershipKind === 'personal' ? authManager.getContactChangeSession() : null;
  const isSessionCurrent = (): boolean => {
    const state = authManager.getAuthState();
    return Boolean(
      initialToken &&
      authManager.getAccessToken() === initialToken &&
      state.isAuthenticated &&
      state.user?.id === initialState.user?.id &&
      state.user?.membershipKind === initialState.user?.membershipKind &&
      authManager.getActiveAuthRealm() === initialRealm &&
      (!passportSession || authManager.isContactChangeSessionCurrent(passportSession)),
    );
  };
  const upgradedUrl = await withConsoleHandoffDeadline(
    resolveConsoleExternalUrl(rawUrl, {
      trustedSender,
      getSessionMode: () => {
        if (!isSessionCurrent()) return null;
        if (initialState.user?.membershipKind === 'org') return 'org';
        if (passportSession) {
          return 'account';
        }
        return null;
      },
      isSessionCurrent,
      getAuthBaseUrl: () => {
        try {
          return getClientEndpointForRealm(authManager.getActiveAuthRealm(), 'authApiBaseUrl');
        } catch {
          return null;
        }
      },
      getConsolePublicOrigin: fetchConsolePublicOrigin,
      requestHandoff: async ({ authBaseUrl, targetPath, entry, sessionMode }) => {
        const normalizedExpected = authBaseUrl.replace(/\/+$/, '');
        if (sessionMode === 'account') {
          if (!passportSession) return null;
          const accountToken = await authManager.issuePassportAccountToken(
            passportSession.realm,
            passportSession.passportId,
          );
          if (!isSessionCurrent()) {
            return null;
          }
          return serverApiFetch<{ handoffUrl?: string }>('/api/auth/console-handoff', {
            baseUrl: () => getClientEndpointForRealm(passportSession.realm, 'authApiBaseUrl'),
            beforeHop: (resolvedBaseUrl) => {
              if (
                !isSessionCurrent() ||
                resolvedBaseUrl.replace(/\/+$/, '') !== normalizedExpected
              ) {
                throw new Error('Auth realm changed before console account handoff request');
              }
            },
            authorization: `Bearer ${accountToken}`,
            skipAutoRefresh: true,
            skipSessionInvalidation: true,
            method: 'POST',
            body: { targetPath, entry },
            timeoutMs: HANDOFF_REQUEST_TIMEOUT_MS,
            redactErrorDetails: true,
            logLabel: '/api/auth/console-handoff',
            expectedErrors: [{ status: 401 }, { status: 403 }, { status: 404 }],
          });
        }
        return serverApiFetch<{ handoffUrl?: string }>('/api/auth/console-handoff', {
          baseUrl: () =>
            getClientEndpointForRealm(authManager.getActiveAuthRealm(), 'authApiBaseUrl'),
          beforeHop: (resolvedBaseUrl) => {
            if (!isSessionCurrent() || resolvedBaseUrl.replace(/\/+$/, '') !== normalizedExpected) {
              throw new Error('Auth realm changed before console handoff request');
            }
          },
          method: 'POST',
          body: { targetPath, entry },
          timeoutMs: HANDOFF_REQUEST_TIMEOUT_MS,
          redactErrorDetails: true,
          logLabel: '/api/auth/console-handoff',
          expectedErrors: [{ status: 401 }, { status: 403 }, { status: 404 }],
        });
      },
      onFallback: (reason) => {
        log.debug('Console handoff fell back to original URL', { reason });
      },
    }),
    rawUrl,
    HANDOFF_REQUEST_TIMEOUT_MS,
  );
  return upgradedUrl !== rawUrl && !isSessionCurrent() ? rawUrl : upgradedUrl;
}
