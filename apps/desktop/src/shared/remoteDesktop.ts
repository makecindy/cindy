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
  CHANNEL_REQUEST: 'remote-desktop:channel-request',
  VIEW_HEARTBEAT: 'remote-desktop:view-heartbeat',
  NATIVE_FRAME: 'remote-desktop:native-frame',
  NATIVE_AUDIO: 'remote-desktop:native-audio',
  WINDOWS_SUPPORT: 'remote-desktop:windows-support',
  PERMISSIONS: 'remote-desktop:permissions',
  OPEN_PERMISSION: 'remote-desktop:open-permission',
  DISMISS_GUIDE: 'remote-desktop:dismiss-permission-guide',
} as const;
export interface DesktopHostCommand {
  iceServers?: DesktopIceServer[];
  id: string;
  op:
    | 'offer'
    | 'stop'
    | 'capture-reset'
    | 'display-hold'
    | 'display-swap'
    | 'viewer-hidden'
    | 'background-viewing'
    | 'ice'
    | 'prepare'
    | 'frame';
  /** Local-only: retain the system-selected Wayland stream for this lease. */
  portalCapture?: boolean;
  attemptId?: string;
  candidates?: RemoteDesktopIceCandidate[];
  after?: number;
  nativeCapture?: boolean;
  /** Local-only: persistent Linux capture follows the negotiated video rate. */
  continuousNativeCapture?: boolean;
  /** Local-only output monitor, enabled only by the main process audio grant. */
  nativeAudio?: boolean;
  cursorOverlay?: boolean;
  /** viewer-hidden: stop sending video while the viewer is hidden. */
  hidden?: boolean;
  /** offer / background-viewing: the viewer is view-only in the background
   * (phone picture-in-picture), so the encoder uses the saver ceilings. */
  background?: boolean;
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
}
export type DesktopHostReply =
  | string
  /** display-swap: true only when native capture kept a live stream;
   * viewer-hidden: true once the video encoder applied the change. */
  | boolean
  | RemoteDesktopIceReply
  | {
      error:
        | 'DESKTOP_AUDIO_UNAVAILABLE'
        | 'DESKTOP_VIDEO_UNAVAILABLE'
        | 'DESKTOP_VIDEO_TIMEOUT'
        | 'DESKTOP_VIDEO_STOPPED';
    }
  | null;
export type WindowsDesktopSupport = 'ready' | 'missing' | 'installRequired' | 'unavailable';
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
  nativeAudio?(lease: string): Promise<Uint8Array>;
  input(lease: string, sequence: number, events: DesktopInput[]): Promise<void>;
  /** A control request the viewer sent over `input-v1`; Main authorizes it. */
  request?(lease: string, request: unknown): Promise<DesktopChannelResult>;
}
export type DesktopChannelResult = { ok: true; result: unknown } | { ok: false; error: string };
