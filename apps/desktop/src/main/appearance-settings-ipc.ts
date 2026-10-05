import { BrowserWindow, ipcMain } from 'electron';
import { extractIpcError } from '../shared/ipcError.js';

import {
  APPEARANCE_LIMITS,
  WALLPAPER_IDS,
  clampAppearanceWallpaperOverlay,
  clampAppearanceCodeSize,
  clampAppearanceUiSize,
  clampAppearanceWindowZoom,
  type AppearanceOverrides,
  type AppearanceSettings,
  type WallpaperId,
} from '../shared/appearanceSettings.js';
import {
  isTrustedAppearanceSettingsReadEvent,
  isTrustedAppearanceSettingsReadWindow,
} from './appearance-settings-reader.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { isAppContentWindow } from './windowFocusClassifier.js';
import {
  readAppearanceSettings,
  readAppearanceSettingsState,
  resetAppearanceSettings,
  updateAppearanceSettingsAtomic,
  writeAppearanceSettingsPatch,
} from './appearance-settings-store.js';

export { writeAppearanceSettingsPatch } from './appearance-settings-store.js';

export const APPEARANCE_SETTINGS_CHANGED_CHANNEL = 'appearance-settings:changed';

let registered = false;

export function registerAppearanceSettingsIpc(): void {
  if (registered) return;
  registered = true;

  // Must be registered before BrowserWindow creation: preload reads this on
  // the first synchronous bootstrap frame.
  ipcMain.on('appearance-settings:get-sync', (event) => {
    event.returnValue = isTrustedAppearanceSettingsReadEvent(event)
      ? appearanceForWindow(readAppearanceSettings(), BrowserWindow.fromWebContents(event.sender))
      : null;
  });

  ipcMain.handle('appearance-settings:get', (event) => {
    assertTrustedAppRendererEvent(event);
    const state = readAppearanceSettingsState();
    broadcast(state.value);
    return state;
  });

  // Local Desktop appearance only: no remote allowlist and no renderer-supplied path.
  ipcMain.handle('appearance-settings:ensure-wallpaper-video', async (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    const { ensureWallpaperVideo } = await import('./wallpaper-video.js');
    const result = await ensureWallpaperVideo(id);
    return result;
  });

  ipcMain.handle('appearance-settings:import-wallpaper', async (event) => {
    assertTrustedAppRendererEvent(event);
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent) throwIpcError('INVALID_PARAMS', 'Wallpaper picker requires an application window');
    try {
      const { importCustomWallpaper } = await import('./custom-wallpaper.js');
      if (!(await importCustomWallpaper(parent))) return null;
      const settings = readAppearanceSettings();
      broadcast(settings);
      return settings;
    } catch (error) {
      throwIpcError(
        extractIpcError(error)?.code === 'INVALID_PARAMS' ? 'INVALID_PARAMS' : 'INTERNAL',
        'Unable to import wallpaper image',
      );
    }
  });

  ipcMain.handle('appearance-settings:remove-wallpaper', async (event) => {
    assertTrustedAppRendererEvent(event);
    try {
      const { removeCustomWallpaper } = await import('./custom-wallpaper.js');
      await removeCustomWallpaper();
      const settings = readAppearanceSettings();
      broadcast(settings);
      return settings;
    } catch {
      throwIpcError('INTERNAL', 'Unable to remove wallpaper image');
    }
  });

  ipcMain.handle('appearance-settings:set-patch', async (event, rawPatch: unknown) => {
    assertTrustedAppRendererEvent(event);
    const patch = parsePatch(rawPatch);
    const settings = await writeAppearanceSettingsPatch(patch);
    applyAppearanceToWindows(settings);
    broadcast(settings);
    return settings;
  });

  ipcMain.handle('appearance-settings:reset', async (event) => {
    assertTrustedAppRendererEvent(event);
    const settings = await resetAppearanceSettings();
    applyAppearanceToWindows(settings);
    broadcast(settings);
    return settings;
  });
}

export function applyAppearanceToWindow(
  win: BrowserWindow,
  settings: Pick<AppearanceSettings, 'windowZoom'> = readAppearanceSettings(),
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed() || !isAppContentWindow(win)) return;
  win.webContents.setZoomFactor(settings.windowZoom);
}

export function applyAppearanceToWindows(settings = readAppearanceSettings()): void {
  for (const win of BrowserWindow.getAllWindows()) {
    applyAppearanceToWindow(win, settings);
  }
}

export function getPersistedWindowZoom(): number {
  return readAppearanceSettings().windowZoom;
}

export async function updatePersistedWindowZoom(delta: number | null): Promise<AppearanceSettings> {
  const settings = await updateAppearanceSettingsAtomic((current) => ({
    windowZoom: clampAppearanceWindowZoom(delta === null ? 1 : current.windowZoom + delta),
  }));
  applyAppearanceToWindows(settings);
  broadcast(settings);
  return settings;
}

// A font/theme reader is not a grant to the client's custom media capability.
function appearanceForWindow(settings: AppearanceSettings, win: BrowserWindow | null): AppearanceSettings {
  if (isAppContentWindow(win)) return settings;
  const { customWallpaperUrl: _privateUrl, ...publicSettings } = settings;
  return {
    ...publicSettings,
    wallpaperId: settings.wallpaperId === 'custom' ? 'none' : settings.wallpaperId,
  };
}

function broadcast(settings: AppearanceSettings): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppearanceSettingsReadWindow(win)) continue;
    try {
      win.webContents.send(APPEARANCE_SETTINGS_CHANGED_CHANNEL, appearanceForWindow(settings, win));
    } catch {
      // A window may be torn down between enumeration and send.
    }
  }
}

function parsePatch(rawPatch: unknown): AppearanceOverrides {
  if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    throwIpcError('INVALID_PARAMS', 'appearance patch must be an object');
  }
  const raw = rawPatch as Record<string, unknown>;
  const allowed = new Set([
    'uiFamily',
    'codeFamily',
    'uiSize',
    'codeSize',
    'windowZoom',
    'wallpaperId',
    'wallpaperOverlay',
    'wallpaperMotion',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throwIpcError('INVALID_PARAMS', `unknown appearance field: ${key}`);
  }
  const patch: AppearanceOverrides = {};
  if ('uiFamily' in raw) patch.uiFamily = parseFamily(raw.uiFamily, 'uiFamily');
  if ('codeFamily' in raw) patch.codeFamily = parseFamily(raw.codeFamily, 'codeFamily');
  if ('uiSize' in raw)
    patch.uiSize = parseNumber(
      raw.uiSize,
      'uiSize',
      clampAppearanceUiSize,
      APPEARANCE_LIMITS.uiSize,
    );
  if ('codeSize' in raw)
    patch.codeSize = parseNumber(
      raw.codeSize,
      'codeSize',
      clampAppearanceCodeSize,
      APPEARANCE_LIMITS.codeSize,
    );
  if ('windowZoom' in raw) {
    patch.windowZoom = parseNumber(
      raw.windowZoom,
      'windowZoom',
      clampAppearanceWindowZoom,
      APPEARANCE_LIMITS.windowZoom,
    );
  }
  if ('wallpaperId' in raw) {
    if (
      typeof raw.wallpaperId !== 'string' ||
      !(WALLPAPER_IDS as readonly string[]).includes(raw.wallpaperId)
    ) {
      throwIpcError('INVALID_PARAMS', 'wallpaperId is not supported');
    }
    patch.wallpaperId = raw.wallpaperId as WallpaperId;
  }
  if ('wallpaperOverlay' in raw) {
    patch.wallpaperOverlay = parseNumber(
      raw.wallpaperOverlay,
      'wallpaperOverlay',
      clampAppearanceWallpaperOverlay,
      APPEARANCE_LIMITS.wallpaperOverlay,
    );
  }
  if ('wallpaperMotion' in raw) {
    if (raw.wallpaperMotion !== 'static' && raw.wallpaperMotion !== 'dynamic') {
      throwIpcError('INVALID_PARAMS', 'wallpaperMotion is not supported');
    }
    patch.wallpaperMotion = raw.wallpaperMotion;
  }
  return patch;
}

function parseFamily(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 256) {
    throwIpcError('INVALID_PARAMS', `${name} must be a string up to 256 characters`);
  }
  return value.trim();
}

function parseNumber(
  value: unknown,
  name: string,
  clamp: (value: number) => number,
  limits: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throwIpcError('INVALID_PARAMS', `${name} must be a finite number`);
  }
  if (value < limits.min || value > limits.max) {
    // Main owns clamping: accepting out-of-range values keeps the IPC stable
    // for sliders and keyboard controls without allowing invalid disk state.
    return clamp(value);
  }
  return clamp(value);
}

export const __testing = { parsePatch };
