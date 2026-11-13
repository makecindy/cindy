import type { RemoteDesktopLeaseScreen } from '@cindy/device-link';

/**
 * A plugin's own view of its live screens on another of the account's
 * computers. The plugin's logic page asks (`live-screen-view-request`), Main
 * answers with a loopback address that speaks the plugin's own live screen
 * frame format, and an app window relays the picture it receives from that
 * computer. The window never draws anything: the plugin's page does.
 */
export const LIVE_SCREEN_RELAY = {
  /** Renderer → Main: this window can relay pictures. */
  HOST: 'live-screen-relay:host',
  /** Main → renderer. */
  START: 'live-screen-relay:start',
  STOP: 'live-screen-relay:stop',
  INPUT: 'live-screen-relay:input',
  KEYFRAME: 'live-screen-relay:keyframe',
  RETRY: 'live-screen-relay:retry',
  /** Renderer → Main. */
  STATE: 'live-screen-relay:state',
  FRAME: 'live-screen-relay:frame',
} as const;

export type LiveScreenRelayStatus = 'connecting' | 'live' | 'reconnecting' | 'ended';

export interface LiveScreenRelayState {
  status: LiveScreenRelayStatus;
  /** Why it is not live: a remote desktop failure code or key. */
  error?: string;
  /** The device shown, once that computer has granted the view. */
  screen?: RemoteDesktopLeaseScreen;
  /** The picture's upright size in pixels; it changes as the device turns. */
  width?: number;
  height?: number;
}

export interface LiveScreenRelayStart {
  relayId: string;
  deviceId: string;
  screen: { plugin: string; id: string; pluginIdentity?: string };
}

export interface LiveScreenRelayBridge {
  host(): Promise<void>;
  onStart(listener: (payload: LiveScreenRelayStart) => void): () => void;
  onStop(listener: (payload: { relayId: string }) => void): () => void;
  onInput(listener: (payload: { relayId: string; events: unknown[] }) => void): () => void;
  onKeyframe(listener: (payload: { relayId: string }) => void): () => void;
  /** The user asked to connect again; this takes the view over from another device. */
  onRetry(listener: (payload: { relayId: string }) => void): () => void;
  state(relayId: string, state: LiveScreenRelayState): void;
  /** `kind` is a live screen message type: 1 description, 2 keyframe, 3 delta. */
  frame(relayId: string, kind: number, bytes: Uint8Array): void;
}

/** What a plugin page is told through the stream's JSON messages. */
export type LiveScreenViewMessage =
  | { type: 'state'; state: LiveScreenRelayStatus; error?: string }
  | ({ type: 'device' } & Omit<RemoteDesktopLeaseScreen, 'plugin'>)
  | { type: 'screen'; width: number; height: number };
