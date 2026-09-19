import { BrowserWindow, ipcMain, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import {
  DESKTOP_COMPANION_GET_STATE_CHANNEL,
  DESKTOP_COMPANION_GET_PREVIEW_CHANNEL,
  DESKTOP_COMPANION_REFRESH_CHANNEL,
  DESKTOP_COMPANION_SET_ENABLED_CHANNEL,
  DESKTOP_COMPANION_SET_LOCATION_ENABLED_CHANNEL,
  DESKTOP_COMPANION_STATE_EVENT_CHANNEL,
} from '../../shared/desktopCompanion.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';

import { generateDesktopCompanionStill, generateDesktopCompanionVideo, peekDesktopCompanionMedia } from './media.js';
import { listMemoryTopics } from './memories.js';
import { characterReferencePath, MacDesktopCompanionNativeHost } from './nativeHost.js';
import { DesktopCompanionService, materializeToApplyDir } from './service.js';
import { readPersistedState, writePersistedState } from './store.js';
import { readRecentCompanionTask } from './tasks.js';

const log = createLogger('desktop-companion');

let service: DesktopCompanionService | null = null;
let nativeHost: MacDesktopCompanionNativeHost | null = null;
let runtimeStarted = false;

function statePath(): string {
  return ownerScopedUserDataPath('desktop-companion', 'state.json');
}

function applyDir(): string {
  return ownerScopedUserDataPath('desktop-companion', 'apply');
}

function shouldReduceMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings?.().prefersReducedMotion === true;
  } catch {
    return false;
  }
}

function ownerKey(): string {
  return ownerScopedUserDataPath('desktop-companion');
}

function removeFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // best-effort cache cleanup
  }
}

function sweepOrphans(keep: ReadonlySet<string>): void {
  try {
    for (const entry of fs.readdirSync(applyDir())) {
      const fullPath = path.join(applyDir(), entry);
      if (!keep.has(fullPath) && fs.statSync(fullPath).isFile()) {
        removeFile(fullPath);
      }
    }
  } catch {
    // apply dir may not exist yet
  }
}

export function getDesktopCompanionService(): DesktopCompanionService {
  if (service) return service;
  nativeHost = new MacDesktopCompanionNativeHost();
  service = new DesktopCompanionService({
    now: () => Date.now(),
    isMac: () => process.platform === 'darwin',
    shouldReduceMotion,
    readState: () => readPersistedState(statePath()),
    writeState: (next) => writePersistedState(statePath(), next),
    applyDir,
    characterRefPath: characterReferencePath,
    ownerKey,
    removeFile,
    sweepOrphans,
    collectContext: async (locationEnabled) => {
      const task = await readRecentCompanionTask().catch((error) => {
        log.warn('read task failed', { error: String(error) });
        return null;
      });
      const memoryRoot = ownerScopedUserDataPath('maker-memory');
      const memoryTopics = listMemoryTopics(memoryRoot);
      let city: string | null = null;
      if (locationEnabled) {
        try {
          city = (await nativeHost?.locateCity()) ?? null;
        } catch (error) {
          log.warn('locate failed', { error: String(error) });
        }
      }
      return { taskTitle: task?.title ?? null, memoryTopics, city };
    },
    peekMedia: peekDesktopCompanionMedia,
    generateStill: (prompt, refPath) => generateDesktopCompanionStill({ prompt, refPath }),
    generateVideo: (prompt, stillPath) => generateDesktopCompanionVideo({ prompt, stillPath }),
    materialize: (media, kind) => materializeToApplyDir(applyDir(), media, kind),
    setWallpaper: async (stillPath) => {
      await nativeHost?.setWallpaper(stillPath);
    },
    playVideo: async (videoPath) => {
      await nativeHost?.playVideo(videoPath);
    },
    stopVideo: async () => {
      await nativeHost?.stopVideo();
    },
    toPreviewSrc: (filePath) => filePath,
  });
  return service;
}

export function startDesktopCompanion(): void {
  if (process.platform !== 'darwin') return;
  getDesktopCompanionService().start();
}

export async function resetDesktopCompanion(): Promise<void> {
  if (!service) return;
  service.stop();
  await nativeHost?.stop();
  service.start();
}

export async function disposeDesktopCompanion(): Promise<void> {
  if (!service) return;
  service.stop();
  await nativeHost?.stop();
}

function broadcastDesktopCompanionState(): void {
  if (!service) return;
  const snapshot = service.snapshot();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(DESKTOP_COMPANION_STATE_EVENT_CHANNEL, snapshot);
  }
}

function registerDesktopCompanionIpc(): void {
  const companion = getDesktopCompanionService();
  companion.subscribe(() => broadcastDesktopCompanionState());
  ipcMain.handle(DESKTOP_COMPANION_GET_STATE_CHANNEL, () => companion.snapshot());
  ipcMain.handle(DESKTOP_COMPANION_SET_ENABLED_CHANNEL, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'enabled must be boolean');
    return companion.setEnabled(enabled);
  });
  ipcMain.handle(DESKTOP_COMPANION_SET_LOCATION_ENABLED_CHANNEL, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'locationEnabled must be boolean');
    return companion.setLocationEnabled(enabled);
  });
  ipcMain.handle(DESKTOP_COMPANION_REFRESH_CHANNEL, async () => companion.refresh());
  ipcMain.handle(DESKTOP_COMPANION_GET_PREVIEW_CHANNEL, async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string') throwIpcError('INVALID_PARAMS', 'filePath required');
    const state = readPersistedState(statePath());
    if (state.lastStillPath !== filePath) {
      throwIpcError('INVALID_PARAMS', 'preview path does not match the current wallpaper');
    }
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > 12 * 1024 * 1024) {
      throwIpcError('INVALID_PARAMS', 'preview file unavailable');
    }
    const buffer = await fs.promises.readFile(filePath);
    const mime = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return 'data:' + mime + ';base64,' + buffer.toString('base64');
  });
}

export function ensureDesktopCompanionRuntime(): void {
  if (runtimeStarted) return;
  runtimeStarted = true;
  registerDesktopCompanionIpc();
  startDesktopCompanion();
}
