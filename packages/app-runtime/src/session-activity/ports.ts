import type { AgentEvent } from '@cindy/maker-core';
import type { ToolRowWording } from '@cindy/maker-shared/message-presentation';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { createAgentIslandCompanionIdentity } from './companionIdentity.js';
import type { AgentIslandNativeRenderer } from './service.js';
import type { MacAgentIslandNativeHostOptions, Rectangle } from './nativeTypes.js';
import type { AgentIslandLayoutPreference } from './geometry.js';

export interface AgentIslandWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  getBounds(): Rectangle;
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void };
}

export interface AgentIslandDisplay {
  id: number;
  bounds: Rectangle;
  label?: string;
  internal?: boolean;
}

export interface AgentIslandOpenDialogOptions {
  properties: ['openFile'];
  filters: Array<{ name: string; extensions: string[] }>;
}

/** Actual Desktop presentation ports. A server does not supply this object. */
export interface AgentIslandUiHost<Window extends AgentIslandWindow, Event> {
  getAllWindows(): Window[];
  windowForEvent(event: Event): Window | null;
  isMainWindowSender(window: Window, event: Event): boolean;
  isAppContentWindow(window: Window): boolean;
  isFocusedAppContentWindow(window: Window): boolean;
  openMainWindowSession(id: string, options?: { islandEntryId?: string }): void;
  confirmIslandArchive(id: string, deviceId?: string | null): Promise<boolean>;
  createNativeHost(options: MacAgentIslandNativeHostOptions): AgentIslandNativeRenderer;
  readAgentIslandLayoutPreferences(): Map<number, AgentIslandLayoutPreference>;
  readAgentIslandDetachedLayoutPreferences(): AgentIslandLayoutPreference[];
  writeAgentIslandLayoutPreference(id: number, preference: AgentIslandLayoutPreference): void;
  writeAgentIslandLayoutPreferences(preferences: Map<number, AgentIslandLayoutPreference>, detached: readonly AgentIslandLayoutPreference[]): void;
  showOpenDialog(owner: Window | null, options: AgentIslandOpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  showActionError(message: string): void;
  onToolResultFull(event: AgentEvent, getMainWindow: () => Window | null): void;
  screen: {
    getAllDisplays(): AgentIslandDisplay[];
    getDisplayMatching(bounds: Rectangle): AgentIslandDisplay;
    getPrimaryDisplay(): AgentIslandDisplay;
  };
}

export interface AgentIslandRuntimeHost<Window extends AgentIslandWindow, Event>
  extends Pick<ReturnType<typeof createAgentIslandCompanionIdentity>, 'readAgentIslandCompanion' | 'companionAvatarHasArtwork' | 'companionAvatarThumbnail' | 'companionSnapshotWithoutArtwork'> {
  ui?: AgentIslandUiHost<Window, Event>;
  log: DbLogger;
  t(key: string): string;
  ipcMain: { handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void };
  getSessionRowSnapshot(id: string): Promise<{ title: string | null; workingDir: string | null; workspaceKind: string | null; source?: string | null } | null | undefined>;
  patchSessionMetaInDb(id: string, patch: { status: 'archived' }, options: { routeLockHeld: true; beforeWrite(): void }): Promise<unknown>;
  withSessionRouteLock<T>(id: string, work: () => Promise<T>): Promise<T>;
  remoteInvoke(id: string, channel: string, args: unknown[]): Promise<{ ok: true; result: unknown } | { ok: false; error: { message: string } }>;
  hasImBinding(id: string): boolean;
  setAgentIslandCompanionChangeSink(sink: { companionChanged(id: string): void; groupChanged(id: string): void }): void;
  clearAppBadgeSessionAttention(id: string, source: 'explicit' | 'passive'): void;
  hasAppBadgeSessionAttention(id: string): boolean;
  isDeviceLinkInvoke(): boolean;
  tapWindowBroadcast(channel: string, payload: unknown): void;
  createLocalizedToolRowWording(): ToolRowWording;
  throwIpcError(code: 'INVALID_PARAMS' | 'PERMISSION_DENIED' | 'PRECONDITION_FAILED', message: string): never;
  assertTrustedAppRendererEvent(event: Event): void;
  getActiveAppSession(): { dataOwnerId: string | null; generation: number };
}
