import { REMOTE_DESKTOP_DEFAULT_IDLE_MINUTES } from '@cindy/device-link';
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
  HIDDEN: 'remote-desktop-viewer:hidden',
  LOCALE: 'remote-desktop-viewer:locale',
  FULLSCREEN: 'remote-desktop-viewer:fullscreen',
  RESIZE: 'remote-desktop-viewer:resize',
  INPUT_FOCUS: 'remote-desktop-viewer:input-focus',
  PREFERENCES: 'remote-desktop-viewer:preferences',
  SAFETY: 'remote-desktop-viewer:safety',
  CLIPBOARD_SYNC: 'remote-desktop-viewer:clipboard-sync',
  CREDENTIAL: 'remote-desktop-viewer:credential',
  RESOLUTION: 'remote-desktop-viewer:resolution',
  CHANNEL_REQUEST: 'remote-desktop-viewer:channel-request',
  CHANNEL_REPLY: 'remote-desktop-viewer:channel-reply',
} as const;

/**
 * A device screen shown inside an app window (a sidebar tab) rather than in its
 * own viewer window. Main owns the target and lease exactly as for a viewer
 * window; these channels only carry what a device screen needs.
 */
export const LIVE_SCREEN_EMBED = {
  OPEN: 'live-screen-embed:open',
  REQUEST: 'live-screen-embed:request',
  ICE: 'live-screen-embed:ice',
  CLOSE: 'live-screen-embed:close',
  CHANNEL_REPLY: 'live-screen-embed:channel-reply',
  ACTIVE: 'live-screen-embed:active',
  CHANNEL_REQUEST: 'live-screen-embed:channel-request',
} as const;
export const LIVE_SCREEN_EMBED_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Preload bridge of the embedded device screen; `embedId` names one mounted panel. */
export interface LiveScreenEmbedBridge {
  /** Binds a new connection to this panel; any earlier one of the same id ends. */
  open(embedId: string, target: RemoteViewerTarget): Promise<RemoteViewerState>;
  request(
    embedId: string,
    generation: number,
    request: RemoteDesktopRequest,
    mediaAttempt?: string,
  ): Promise<unknown>;
  ice(embedId: string, generation: number, mediaAttempt: string): Promise<DesktopIceServer[]>;
  close(embedId: string): Promise<void>;
  channelReply(
    embedId: string,
    generation: number,
    id: string,
    outcome: RemoteViewerChannelOutcome,
  ): Promise<void>;
  /** Main ended the connection (account change, this computer locked or went to sleep). */
  onActive(listener: (payload: { embedId: string; state: RemoteViewerState }) => void): () => void;
  onChannelRequest(
    listener: (payload: { embedId: string } & RemoteViewerChannelRequest) => void,
  ): () => void;
}

export interface RemoteViewerTarget {
  deviceId: string;
  name: string;
  /** 代输入 live view: only the window this waiting request is about (the host picks it). */
  handoff?: string;
  /**
   * A plugin live screen (such as a simulator) from that computer's `screens`
   * list: only that device's picture, with input going to the plugin. `name`
   * is the listed name, shown until the host's lease confirms it.
   */
  screen?: RemoteViewerScreen;
}
export interface RemoteViewerScreen {
  plugin: string;
  pluginIdentity?: string;
  id: string;
  name?: string;
}
/** Two targets open the same viewer window only when they show the same thing. */
export function sameViewerScope(
  a: Pick<RemoteViewerTarget, 'deviceId' | 'handoff' | 'screen'> | null | undefined,
  b: Pick<RemoteViewerTarget, 'deviceId' | 'handoff' | 'screen'>,
): boolean {
  return (
    a?.deviceId === b.deviceId &&
    a.handoff === b.handoff &&
    a.screen?.plugin === b.screen?.plugin &&
    a.screen?.pluginIdentity === b.screen?.pluginIdentity &&
    a.screen?.id === b.screen?.id
  );
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
  idleTimeoutMinutes: number;
}
export const DEFAULT_VIEWER_PREFERENCES: RemoteViewerPreferences = {
  audio: true,
  privacyScreen: true,
  hostMute: false,
  clipboardSync: false,
  lockOnExit: true,
  idleTimeoutMinutes: REMOTE_DESKTOP_DEFAULT_IDLE_MINUTES,
};
export interface RemoteViewerSafety {
  privacyActive: boolean;
  notice: string | null;
  /** New skipped/conflicting snapshot; idle polls keep the occurrence. Local IPC only. */
  clipboardNoticeVersion?: number;
  clipboardProgress: number | null;
}
/**
 * The last display choice for one monitor of the target computer. `mode` is a
 * system resolution; `fit` is the requested size of a picture fitted to the
 * viewer window, reapplied at the window's current ratio on the next connection.
 */
export type RememberedViewerResolution =
  | { kind: 'mode'; modeId: string; width: number; height: number }
  | { kind: 'fit'; width: number; height: number };

export function parseRememberedViewerResolution(value: unknown): RememberedViewerResolution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const size = [v.width, v.height];
  if (!size.every((n) => Number.isInteger(n) && (n as number) >= 320 && (n as number) <= 8192))
    return null;
  const width = v.width as number,
    height = v.height as number;
  if (
    v.kind === 'mode' &&
    typeof v.modeId === 'string' &&
    v.modeId.length > 0 &&
    v.modeId.length <= 256
  )
    return { kind: 'mode', modeId: v.modeId, width, height };
  return v.kind === 'fit' && width <= 2560 && height <= 2560
    ? { kind: 'fit', width, height }
    : null;
}

/** A request Main asks the viewer window to send over its live media data channel. */
export interface RemoteViewerChannelRequest {
  generation: number;
  id: string;
  request: RemoteDesktopRequest;
}
/** How a channel request ended; `relay` means it was never sent, so Main may use the relay. */
export type RemoteViewerChannelOutcome =
  { kind: 'result'; value: unknown } | { kind: 'relay' } | { kind: 'error'; code: string };

export function parseRemoteViewerChannelOutcome(value: unknown): RemoteViewerChannelOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === 'relay') return { kind: 'relay' };
  if (v.kind === 'result') return { kind: 'result', value: v.value };
  return v.kind === 'error' && typeof v.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v.code)
    ? { kind: 'error', code: v.code }
    : null;
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
  /** Native hide/minimize (incl. macOS Space switches and full occlusion) and show/restore. */
  onHidden?(listener: (hidden: boolean) => void): () => void;
  inputFocus(generation: number, focused: boolean): Promise<void>;
  preferences?(
    generation: number,
    patch?: Partial<RemoteViewerPreferences>,
  ): Promise<RemoteViewerPreferences>;
  safety?(generation: number, retry?: boolean): Promise<RemoteViewerSafety>;
  /** One clipboard sync pass now (copy/paste in the picture) instead of at the next poll. */
  clipboardSync?(generation: number): Promise<RemoteViewerSafety>;
  /** Main routes channel-eligible requests through the window's media data channel. */
  onChannelRequest?(listener: (request: RemoteViewerChannelRequest) => void): () => void;
  channelReply?(generation: number, id: string, outcome: RemoteViewerChannelOutcome): Promise<void>;
  /** Reads the remembered choice for a monitor; a second argument replaces it (`null` forgets). */
  resolution?(
    generation: number,
    displayId: string,
    value?: RememberedViewerResolution | null,
  ): Promise<RememberedViewerResolution | null>;
  credential?(
    generation: number,
    action: 'settings' | 'enable' | 'disable' | 'unlock' | 'biometric',
    enabled?: boolean,
  ): Promise<RemoteViewerCredentialState>;
}
