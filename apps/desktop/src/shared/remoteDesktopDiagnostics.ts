/** Local diagnostics only: never include request payloads, credentials or raw leases. */
export interface DesktopHeartbeatSample {
  /** Viewer request time includes queueing; it is not proof of a socket write. */
  requestedAt?: number;
  settledAt?: number;
  /** Host receipt time, never used for a locally timed-out viewer request. */
  receivedAt?: number;
  result?: string;
}

export class DesktopHeartbeatHistory {
  private samples: DesktopHeartbeatSample[] = [];

  add(sample: DesktopHeartbeatSample): DesktopHeartbeatSample {
    this.samples.push(sample);
    if (this.samples.length > 8) this.samples.shift();
    return sample;
  }

  snapshot(): DesktopHeartbeatSample[] {
    return this.samples.map((sample) => ({ ...sample }));
  }
}

const DIAGNOSTIC_CODES = new Set([
  'DESKTOP_LEASE_EXPIRED',
  'DESKTOP_STOPPED',
  'DESKTOP_VIEW_ONLY',
  'DESKTOP_CONNECTION_TIMEOUT',
  'DESKTOP_INPUT_UNAVAILABLE',
  'DESKTOP_INPUT_TIMEOUT',
  'DESKTOP_INPUT_BUSY',
  'DESKTOP_INPUT_UNSUPPORTED',
  'DESKTOP_BUSY',
  'DESKTOP_DISABLED',
  'DESKTOP_AUTHENTICATION_REQUIRED',
  'DESKTOP_UNAVAILABLE',
  'DESKTOP_ACCESSIBILITY_REQUIRED',
  'DESKTOP_AUDIO_UNAVAILABLE',
  'DESKTOP_CAPTURE_PENDING',
  'DESKTOP_CLIPBOARD_BUSY',
  'DESKTOP_CLIPBOARD_CHANGED',
  'DESKTOP_CLIPBOARD_COPY_FAILED',
  'DESKTOP_CLIPBOARD_INVALID',
  'DESKTOP_CLIPBOARD_UNAVAILABLE',
  'DESKTOP_CLIPBOARD_WRITE_FAILED',
  'DESKTOP_DISPLAY_BUSY',
  'DESKTOP_DISPLAY_MISSING',
  'DESKTOP_DISPLAY_MODES_UNAVAILABLE',
  'DESKTOP_DISPLAY_MODE_MISSING',
  'DESKTOP_HANDOFF_ENDED',
  'DESKTOP_HANDOFF_UNAVAILABLE',
  'DESKTOP_HANDOFF_WINDOW_ONLY',
  'DESKTOP_HOST_MUTE_UNAVAILABLE',
  'DESKTOP_INPUT_PREPARING',
  'DESKTOP_LOCKED',
  'DESKTOP_LOCK_FAILED',
  'DESKTOP_LOCK_UNAVAILABLE',
  'DESKTOP_PERMISSIONS_UNAVAILABLE',
  'DESKTOP_PRIVACY_UNAVAILABLE',
  'DESKTOP_SCREEN_PERMISSION_REQUIRED',
  'DESKTOP_SYSTEM_SERVICE_UNAVAILABLE',
  'DESKTOP_VIDEO_BUSY',
  'DESKTOP_VIDEO_STOPPED',
  'DESKTOP_VIDEO_TIMEOUT',
  'DESKTOP_VIDEO_UNAVAILABLE',
  'DESKTOP_VIEWER_DISPLAY_UNAVAILABLE',
  'INVOKE_TIMEOUT',
  'BACKPRESSURE',
  'DEVICE_LINK_BUSY',
  'DEVICE_UNRESPONSIVE',
  'DEVICE_OFFLINE',
  'NOT_CONNECTED',
  'LINK_CLOSED',
  'LINK_NOT_OPEN',
  'PEER_RESET',
  'ACCESS_REVOKED',
  'CHANNEL_NOT_ALLOWED',
  'REMOTE_DISABLED',
]);

/** Exact allowlist: arbitrary error messages can contain private request data. */
export function desktopDiagnosticCode(value: unknown): string {
  const code = value instanceof Error ? value.message : value;
  return typeof code === 'string' && DIAGNOSTIC_CODES.has(code) ? code : 'UNKNOWN_ERROR';
}

/** Same truncated SHA-256 as Main, without exposing a lease through a new IPC. */
export async function desktopDiagnosticId(lease: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(lease));
  return Array.from(new Uint8Array(hash).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
