export type BrowserBackendKind = 'external' | 'rsb-webview';

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
