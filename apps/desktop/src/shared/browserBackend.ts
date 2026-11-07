export type BrowserBackendKind = 'external' | 'rsb-webview' | 'user-browser';

/** Optional profile stores; warning payloads never carry paths or native errors. */
export const OPTIONAL_BROWSER_PROFILE_DATABASES = [
  'Login Data',
  'Login Data For Account',
  'Web Data',
] as const;

export interface BrowserProfileCopyWarning {
  database: (typeof OPTIONAL_BROWSER_PROFILE_DATABASES)[number];
  reason: 'locked' | 'permission-denied' | 'copy-failed';
}

/** Only known, non-sensitive fields may cross the runtime / IPC boundary. */
export function browserProfileCopyWarningsFromData(data: unknown): BrowserProfileCopyWarning[] {
  const raw = (data as { realProfile?: { warnings?: unknown } } | null)?.realProfile?.warnings;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { database, reason } = entry;
    if (!(OPTIONAL_BROWSER_PROFILE_DATABASES as readonly unknown[]).includes(database)) return [];
    if (reason !== 'locked' && reason !== 'permission-denied' && reason !== 'copy-failed')
      return [];
    return [{ database, reason } as BrowserProfileCopyWarning];
  });
}

/** Thrown when start/open would attach to another Cindy instance's Chrome on CDP 18800. */
export const FOREIGN_AGENT_BROWSER_ERROR = 'FOREIGN_AGENT_BROWSER';

/** Thrown when macOS TCC / file permissions block reading the system Chrome profile. */
export const REAL_PROFILE_READ_DENIED = 'REAL_PROFILE_READ_DENIED';

export const BROWSER_OPEN_FOR_LOGIN_ERROR_CODES = [
  'PROFILE_LOCKED',
  REAL_PROFILE_READ_DENIED,
  'NO_CHROMIUM',
  'NO_AUTH_DB',
  'COPY_FAILED',
  'HEADLESS_FORBIDDEN',
  'STOP_FAILED',
  FOREIGN_AGENT_BROWSER_ERROR,
  'APP_BOUND_ENCRYPTION_UNSUPPORTED',
] as const;

export type BrowserOpenForLoginErrorCode = (typeof BROWSER_OPEN_FOR_LOGIN_ERROR_CODES)[number];

export function isBrowserOpenForLoginErrorCode(
  value: unknown,
): value is BrowserOpenForLoginErrorCode {
  return (BROWSER_OPEN_FOR_LOGIN_ERROR_CODES as readonly unknown[]).includes(value);
}

export class BrowserOpenForLoginError extends Error {
  readonly code: BrowserOpenForLoginErrorCode;

  constructor(code: BrowserOpenForLoginErrorCode) {
    super(code);
    this.name = 'BrowserOpenForLoginError';
    this.code = code;
  }
}

export function isBrowserOpenForLoginError(err: unknown): err is BrowserOpenForLoginError {
  return err instanceof BrowserOpenForLoginError;
}

/** Read a controlled failure reason without exposing runtime details. */
export function browserOpenForLoginErrorCodeFromData(
  data: unknown,
): BrowserOpenForLoginErrorCode | null {
  if (!data || typeof data !== 'object') return null;
  const reason = (data as { reason?: unknown }).reason;
  return isBrowserOpenForLoginErrorCode(reason) ? reason : null;
}

export type BrowserBackendHealthReason =
  | 'disposing'
  | 'host-unavailable'
  | 'start-failed'
  | 'status-failed'
  | 'recovery-failed'
  /** user-browser:提供页面控制的插件已启用,但浏览器扩展尚未连接。 */
  | 'extension-disconnected'
  /** user-browser:没有已安装并启用的页面控制插件。 */
  | 'plugin-missing';

/**
 * 「我的浏览器」推荐安装的页面控制插件(官方 Cindy Chrome)。任何声明
 * browserExtension.pageControl 的插件都可以提供这个目标;这里只用于设置页引导用户去安装。
 */
export const RECOMMENDED_PAGE_CONTROL_PLUGIN_ID = 'my-browser';

/** 官方 Cindy 浏览器扩展的 Chrome 网上应用店页面;设置页直接在用户浏览器里打开它安装扩展。 */
export const RECOMMENDED_PAGE_CONTROL_EXTENSION_STORE_URL =
  'https://chromewebstore.google.com/detail/cindy/dmbhhhdijpeaibfeocdcjhfefkgpkeef';

export type BrowserExtensionStoreOpenResult =
  | { ok: true }
  | { ok: false; error: 'NO_CHROMIUM' | 'OPEN_FAILED' };

export interface BrowserBackendHealth {
  active: BrowserBackendKind;
  status: 'ready' | 'error';
  canRecover: boolean;
  reason?: BrowserBackendHealthReason;
  errorCode?: string;
}

export interface BrowserBackendRecoveryResult {
  ok: boolean;
  health: BrowserBackendHealth;
}

/** Whether the OS Chromium profile can be opened. Never includes paths. */
export interface BrowserBackendSourceReadAccess {
  readable: boolean;
}
