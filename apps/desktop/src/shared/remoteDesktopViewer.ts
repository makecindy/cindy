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
  INPUT_FOCUS: 'remote-desktop-viewer:input-focus',
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
  rendererReady(): Promise<void>;
  presentationReady(): Promise<void>;
  onActive(listener: (state: RemoteViewerState) => void): () => void;
  onLocale(listener: (locale: string) => void): () => void;
  onCloseRequested(listener: (generation: number) => void): () => void;
  inputFocus(generation: number, focused: boolean): Promise<void>;
}
