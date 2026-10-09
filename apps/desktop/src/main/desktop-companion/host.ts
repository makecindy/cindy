import { BrowserWindow, ipcMain, systemPreferences } from 'electron';

import {
  DESKTOP_COMPANION_GET_STATE_CHANNEL,
  DESKTOP_COMPANION_GET_PREVIEW_CHANNEL,
  DESKTOP_COMPANION_REFRESH_CHANNEL,
  DESKTOP_COMPANION_SET_ENABLED_CHANNEL,
  DESKTOP_COMPANION_SET_LOCATION_ENABLED_CHANNEL,
  DESKTOP_COMPANION_SET_SYSTEM_ENABLED_CHANNEL,
  DESKTOP_COMPANION_STATE_EVENT_CHANNEL,
} from '../../shared/desktopCompanion.js';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { parseBlobUrl } from '../cindy-media/blobStore.js';
import { readMemorySettings } from '../maker-host/memory-settings-store.js';
import { createLogger } from '../logger.js';

import { generateDesktopCompanionStill, generateDesktopCompanionVideo, peekDesktopCompanionMedia } from './media.js';
import { listMemoryTopics } from './memories.js';
import { characterReferencePath, MacDesktopCompanionNativeHost } from './nativeHost.js';
import { DesktopCompanionService } from './service.js';
import { normalizePersistedState, readPersistedState, writePersistedState } from './store.js';
import { readRecentCompanionTask } from './tasks.js';
import { companionMediaExists, companionMediaPath, releaseCompanionMedia, storeCompanionMedia } from './managedMedia.js';

const log = createLogger('desktop-companion');
let service: DesktopCompanionService | null = null;
let nativeHost: MacDesktopCompanionNativeHost | null = null;
let runtimeStarted = false;

function hasOwner(): boolean {
  return Boolean(getActiveAppSession().dataOwnerId) && !isAppSessionBoundaryPending();
}

function statePath(): string {
  return ownerScopedUserDataPath('desktop-companion', 'state.json');
}

function assertOwner(): void {
  if (!hasOwner()) throwIpcError('INTERNAL', 'Wallpaper account is not ready');
}

export function getDesktopCompanionService(): DesktopCompanionService {
  if (service) return service;
  nativeHost = new MacDesktopCompanionNativeHost();
  service = new DesktopCompanionService({
    now: () => Date.now(),
    isMac: () => process.platform === 'darwin',
    shouldReduceMotion: () => systemPreferences.getAnimationSettings?.().prefersReducedMotion === true,
    readState: () => hasOwner() ? readPersistedState(statePath()) : normalizePersistedState(null),
    writeState: (next) => { assertOwner(); writePersistedState(statePath(), next); },
    characterRefPath: characterReferencePath,
    ownerKey: activeOwnerScopeKey,
    removeFile: (source) => {
      void releaseCompanionMedia(source).catch(() => log.warn('Wallpaper reference cleanup failed'));
    },
    exists: companionMediaExists,
    collectContext: async (locationEnabled) => {
      assertOwner();
      const owner = activeOwnerScopeKey();
      const memoryTopics = readMemorySettings().maker
        ? listMemoryTopics(ownerScopedUserDataPath('maker-memory'))
        : [];
      const task = await readRecentCompanionTask();
      if (!hasOwner() || activeOwnerScopeKey() !== owner) throw new Error('ACCOUNT_CHANGED');
      const city = locationEnabled && process.platform === 'darwin' ? await nativeHost!.locateCity() : null;
      if (!hasOwner() || activeOwnerScopeKey() !== owner) throw new Error('ACCOUNT_CHANGED');
      return { taskTitle: task?.title ?? null, memoryTopics, city };
    },
    peekMedia: () => hasOwner() ? peekDesktopCompanionMedia() : { image: false, video: false },
    generateStill: (prompt, refPath) => generateDesktopCompanionStill({ prompt, refPath }),
    generateVideo: (prompt, source, assertStillValid) => generateDesktopCompanionVideo({ prompt, stillPath: companionMediaPath(source), assertStillValid }),
    materialize: storeCompanionMedia,
    setWallpaper: (source, assertStillValid) => nativeHost!.setWallpaper(companionMediaPath(source), assertStillValid),
    playVideo: (source, assertStillValid) => nativeHost!.playVideo(companionMediaPath(source), assertStillValid),
    stopVideo: () => nativeHost!.stopVideo(),
    // An opaque marker preserves old previews without disclosing a disk path.
    toPreviewSrc: (source) => source ? (parseBlobUrl(source) ? source : 'legacy') : null,
  });
  return service;
}

export function startDesktopCompanion(): void {
  getDesktopCompanionService().start();
}

export async function resetDesktopCompanion(): Promise<void> {
  service?.stop();
  await nativeHost?.stop();
}

export async function disposeDesktopCompanion(): Promise<void> {
  await resetDesktopCompanion();
}

function broadcastDesktopCompanionState(): void {
  if (!service) return;
  const snapshot = service.snapshot();
  for (const window of BrowserWindow.getAllWindows()) {
    if (isTrustedAppRendererWindow(window))
      window.webContents.send(DESKTOP_COMPANION_STATE_EVENT_CHANNEL, snapshot);
  }
}

function registerDesktopCompanionIpc(): void {
  const companion = getDesktopCompanionService();
  companion.subscribe(broadcastDesktopCompanionState);
  ipcMain.handle(DESKTOP_COMPANION_GET_STATE_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    return companion.snapshot();
  });
  for (const [channel, apply] of [
    [DESKTOP_COMPANION_SET_ENABLED_CHANNEL, (value: boolean) => companion.setEnabled(value)],
    [DESKTOP_COMPANION_SET_LOCATION_ENABLED_CHANNEL, (value: boolean) => companion.setLocationEnabled(value)],
    [DESKTOP_COMPANION_SET_SYSTEM_ENABLED_CHANNEL, (value: boolean) => companion.setSystemEnabled(value)],
  ] as const) {
    ipcMain.handle(channel, async (event, enabled: unknown) => {
      assertTrustedAppRendererEvent(event);
      assertOwner();
      if (typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'enabled must be boolean');
      try { return await apply(enabled); }
      catch { throwIpcError('INTERNAL', 'Unable to update wallpaper settings'); }
    });
  }
  ipcMain.handle(DESKTOP_COMPANION_REFRESH_CHANNEL, async (event) => {
    assertTrustedAppRendererEvent(event);
    assertOwner();
    return companion.refresh();
  });
  ipcMain.handle(DESKTOP_COMPANION_GET_PREVIEW_CHANNEL, async (event, source: unknown) => {
    assertTrustedAppRendererEvent(event);
    assertOwner();
    const owner = activeOwnerScopeKey();
    const generation = companion.snapshot().generation;
    const state = readPersistedState(statePath());
    if (source !== 'legacy' || !state.lastStillPath || parseBlobUrl(state.lastStillPath))
      throwIpcError('INVALID_PARAMS', 'Wallpaper preview is not current');
    try {
      const filePath = companionMediaPath(state.lastStillPath);
      const bytes = await readBoundedFileNoFollow(filePath, 12 * 1024 * 1024);
      if (!bytes || !hasOwner() || activeOwnerScopeKey() !== owner || companion.snapshot().generation !== generation)
        throw new Error('Preview expired');
      const mime = filePath.endsWith('.png') ? 'image/png' : filePath.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return 'data:' + mime + ';base64,' + bytes.toString('base64');
    } catch {
      throwIpcError('INVALID_PARAMS', 'Wallpaper preview is unavailable');
    }
  });
}

export function ensureDesktopCompanionRuntime(): void {
  if (!runtimeStarted) {
    runtimeStarted = true;
    registerDesktopCompanionIpc();
  }
  startDesktopCompanion();
}
