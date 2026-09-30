import type { DesktopIceServer, RemoteDesktopRequest } from '@cindy/device-link';

export const REMOTE_VIEWER = {
  OPEN: 'remote-desktop-viewer:open',
  STATE: 'remote-desktop-viewer:state',
  REQUEST: 'remote-desktop-viewer:request',
  ICE: 'remote-desktop-viewer:ice',
  CLIPBOARD: 'remote-desktop-viewer:clipboard',
  CLOSE: 'remote-desktop-viewer:close',
  CLOSE_REQUESTED: 'remote-desktop-viewer:close-requested',
  READY: 'remote-desktop-viewer:ready',
  PRESENTED: 'remote-desktop-viewer:presented',
  ACTIVE: 'remote-desktop-viewer:active',
  LOCALE: 'remote-desktop-viewer:locale',
  FULLSCREEN: 'remote-desktop-viewer:fullscreen',
  RESIZE: 'remote-desktop-viewer:resize',
  INPUT_FOCUS: 'remote-desktop-viewer:input-focus',
  PREFERENCES: 'remote-desktop-viewer:preferences',
  SAFETY: 'remote-desktop-viewer:safety',
  CREDENTIAL: 'remote-desktop-viewer:credential',
} as const;

export interface RemoteViewerTarget {
  deviceId: string;
  name: string;
}
export interface RemoteViewerState {
  target: RemoteViewerTarget | null;
  active: boolean;
  generation: number;
  resume?: boolean;
}
export type RemoteViewerReply = { ok: true; result: unknown } | { ok: false; code: string };
export interface RemoteViewerPreferences {
  audio: boolean;
  privacyScreen: boolean;
  hostMute: boolean;
  clipboardSync: boolean;
  lockOnExit: boolean;
}
export const DEFAULT_VIEWER_PREFERENCES: RemoteViewerPreferences = {
  audio: true,
  privacyScreen: false,
  hostMute: false,
  clipboardSync: false,
  lockOnExit: false,
};
export interface RemoteViewerSafety {
  privacyActive: boolean;
  notice: string | null;
  clipboardProgress: number | null;
}
export interface RemoteViewerCredentialState {
  available: boolean;
  autoUnlock: boolean;
  biometricAvailable: boolean;
  biometricVerification: boolean;
}
/** Dedicated window bridge. The target and account are bound by Main, never by payload. */
export interface RemoteDesktopViewerApi {
  state(): Promise<RemoteViewerState>;
  request(
    generation: number,
    request: RemoteDesktopRequest,
    mediaAttempt?: string,
  ): Promise<unknown>;
  ice(generation: number, mediaAttempt: string): Promise<DesktopIceServer[]>;
  clipboard(generation: number, action: 'copy' | 'paste'): Promise<void>;
  close(generation: number): Promise<void>;
  fullscreen(): Promise<void>;
  resize(generation: number, width: number, height: number): Promise<void>;
  rendererReady(): Promise<void>;
  presentationReady(): Promise<void>;
  onActive(listener: (state: RemoteViewerState) => void): () => void;
  onLocale(listener: (locale: string) => void): () => void;
  onCloseRequested(listener: (generation: number) => void): () => void;
  inputFocus(generation: number, focused: boolean): Promise<void>;
  preferences?(
    generation: number,
    patch?: Partial<RemoteViewerPreferences>,
  ): Promise<RemoteViewerPreferences>;
  safety?(generation: number, retry?: boolean): Promise<RemoteViewerSafety>;
  credential?(
    generation: number,
    action: 'settings' | 'enable' | 'disable' | 'unlock' | 'biometric',
    enabled?: boolean,
  ): Promise<RemoteViewerCredentialState>;
}
