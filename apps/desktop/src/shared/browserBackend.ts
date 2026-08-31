export type BrowserBackendKind = 'external' | 'rsb-webview';

/** Thrown when start/open would attach to another Cindy instance's Chrome on CDP 18800. */
export const FOREIGN_AGENT_BROWSER_ERROR = 'FOREIGN_AGENT_BROWSER';

/** Thrown when macOS TCC / file permissions block reading the system Chrome profile. */
export const REAL_PROFILE_READ_DENIED = 'REAL_PROFILE_READ_DENIED';

export type BrowserBackendHealthReason =
  | 'disposing'
  | 'host-unavailable'
  | 'start-failed'
  | 'status-failed'
  | 'recovery-failed';

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
