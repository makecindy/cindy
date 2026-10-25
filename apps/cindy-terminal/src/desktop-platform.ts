import type { RemoteDesktopPermissions } from '@cindy/device-link';
import type { InputHandoffService } from '@cindy/remote-agent/input-handoff/service';
import type { HandoffDriver } from '@cindy/remote-agent/input-handoff/driver';
import type { SettingsStore } from './settings.js';

/** Optional operating-system surface. The Node host never imports Electron;
 * a signed graphical-platform entry mounts the existing Desktop implementation
 * in the same authenticated host, without a main window or a second database. */
export interface TerminalDesktopPlatform {
  request(peer: string, value: unknown): Promise<unknown>;
  permissions(action: 'check' | 'guide'): Promise<RemoteDesktopPermissions>;
  createHandoffDriver(): HandoffDriver | null;
  inputBinary(): Promise<string>;
  liveViewAvailable(): boolean;
  peerClosed(peer: string): void;
  signalingLost(peer?: string): void;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface TerminalDesktopPlatformContext {
  settings: SettingsStore;
  handoff(): InputHandoffService | undefined;
  authenticated(): boolean;
  credentials(): Promise<{ realm: 'global' | 'cn'; membership: string; authDevice: string; token: string } | null>;
  iceServers(): Promise<RTCIceServer[]>;
  controllerName(peer: string): string | undefined;
  revoke(peer: string): Promise<void>;
  permissionGuideRequested(): void;
}

export type CreateTerminalDesktopPlatform = (context: TerminalDesktopPlatformContext) => TerminalDesktopPlatform;
