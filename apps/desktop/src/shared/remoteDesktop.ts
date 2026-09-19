import type {
  DesktopInput,
  RemoteDesktopCursorFrame,
  DesktopPermission,
  RemoteDesktopVideoSettings,
  RemoteDesktopPermissions,
  RemoteDesktopIceCandidate,
  RemoteDesktopIceReply,
  DesktopIceServer,
} from '@cindy/device-link';
// Initial capture plus three lease-scoped audio retries; also bounds Main's grant.
export const DESKTOP_AUDIO_RETRY_MS = [3_000, 10_000, 30_000] as const;
export const DESKTOP_LOCAL = {
  STATE: 'remote-desktop:state',
  ENABLE: 'remote-desktop:enable',
  STOP: 'remote-desktop:stop',
  CAPTURE_STOP: 'remote-desktop:capture-stop',
  REGISTER: 'remote-desktop:register-host',
  COMMAND: 'remote-desktop:host-command',
  REPLY: 'remote-desktop:host-reply',
  INPUT: 'remote-desktop:host-input',
  VIEW_HEARTBEAT: 'remote-desktop:view-heartbeat',
  NATIVE_FRAME: 'remote-desktop:native-frame',
  WINDOWS_SUPPORT: 'remote-desktop:windows-support',
  PERMISSIONS: 'remote-desktop:permissions',
  OPEN_PERMISSION: 'remote-desktop:open-permission',
  DISMISS_GUIDE: 'remote-desktop:dismiss-permission-guide',
} as const;
export interface DesktopHostCommand {
  iceServers?: DesktopIceServer[];
  id: string;
  op: 'offer' | 'stop' | 'capture-reset' | 'ice';
  attemptId?: string;
  candidates?: RemoteDesktopIceCandidate[];
  after?: number;
  nativeCapture?: boolean;
  cursorOverlay?: boolean;
  lease?: string;
  sourceId?: string;
  sdp?: string;
  settings?: RemoteDesktopVideoSettings;
}
export interface DesktopLocalState {
  enabled: boolean;
  active: { peer: string; controlling: boolean } | null;
  permissionGuide?: boolean;
  windowsSupport?: WindowsDesktopSupport;
  windowsDevelopment?: boolean;
  windowsSetup?: WindowsDesktopSetupState;
}
export type WindowsDesktopSetupPhase =
  'preparing' | 'compilingHost' | 'compilingInput' | 'authorizing' | 'verifying' | 'removing';
export interface WindowsDesktopSetupState {
  revision: number;
  phase: WindowsDesktopSetupPhase | null;
  error: 'prepare' | 'setup' | null;
  failedEnabled: boolean | null;
  startedAt: number | null;
}
export type DesktopHostReply =
  | string
  | RemoteDesktopIceReply
  | {
      error:
        | 'DESKTOP_AUDIO_UNAVAILABLE'
        | 'DESKTOP_VIDEO_UNAVAILABLE'
        | 'DESKTOP_VIDEO_TIMEOUT'
        | 'DESKTOP_VIDEO_STOPPED';
    }
  | null;
export type WindowsDesktopSupport =
  'ready' | 'missing' | 'installRequired' | 'unavailable' | 'updateRequired';
export interface RemoteDesktopApi {
  state(checkWindowsSupport?: boolean): Promise<DesktopLocalState>;
  enable(enabled: boolean): Promise<void>;
  windowsSupport(enabled: boolean): Promise<void>;
  stop(): Promise<void>;
  permissions(): Promise<RemoteDesktopPermissions>;
  openPermission(permission: DesktopPermission): Promise<void>;
  dismissPermissionGuide(): Promise<void>;
}
/** Narrow bridge exposed only to the dedicated capture surface. */
export interface DesktopCaptureApi {
  stop(): Promise<void>;
  registerHost(): Promise<void>;
  onCommand(listener: (command: DesktopHostCommand) => void): () => void;
  reply(id: string, result: DesktopHostReply): Promise<void>;
  viewHeartbeat(lease: string): Promise<void>;
  nativeFrame(lease: string): Promise<string | RemoteDesktopCursorFrame | null>;
  input(lease: string, sequence: number, events: DesktopInput[]): Promise<void>;
}
