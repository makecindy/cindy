export type BrowserBackendKind = 'external' | 'rsb-webview';

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
  'disposing' | 'host-unavailable' | 'start-failed' | 'status-failed' | 'recovery-failed';

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
