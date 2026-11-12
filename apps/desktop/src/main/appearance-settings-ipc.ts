import { app, BrowserWindow, ipcMain } from 'electron';
import { extractIpcError } from '../shared/ipcError.js';

import {
  APPEARANCE_LIMITS,
  WALLPAPER_IDS,
  WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL,
  clampAppearanceWallpaperOverlay,
  clampAppearanceWallpaperVisibility,
  clampAppearanceWallpaperBlur,
  clampAppearanceCodeSize,
  clampAppearanceTerminalSize,
  clampAppearanceUiSize,
  clampAppearanceWindowZoom,
  isAppIcon,
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
import { refreshMacSidebarGeometry } from './macosDesktopBlur.js';
import {
  readAppearanceSettings,
  readAppearanceSettingsState,
  resetAppearanceSettings,
  updateAppearanceSettingsAtomic,
  writeAppearanceSettingsPatch,
  appearanceService,
  readSelectedThemeFont,
} from './appearance-settings-store.js';
import { parseThemeSelection } from '../shared/appearanceDefinition.js';
import { APPEARANCE_RESET_FIELDS, appearanceResetPatch } from './appearance/definition.js';
import { applyDockIcon } from './app-icon.js';
import { pluginAppearanceRevision } from './cindy-brain/pluginAppearanceRevision.js';
import { LOCAL_THEME_SUFFIX } from '../shared/local-themes.js';

export { writeAppearanceSettingsPatch } from './appearance-settings-store.js';

export const APPEARANCE_SETTINGS_CHANGED_CHANNEL = 'appearance-settings:changed';

let registered = false;

export function registerAppearanceSettingsIpc(): void {
  if (registered) return;
  registered = true;
  // The saved scale can survive while the native window displays a different
  // zoom (#7486). Restore it on activation without rewriting the preference or
  // repeatedly applying an already matching scale. Only app-content windows
  // participate; embedded webpages and utility windows keep their own zoom.
  app.on('browser-window-focus', function restoreFocusedWindowZoom(_event, win) {
    restoreWindowZoom(win);
  });

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

  ipcMain.handle('appearance-settings:plugin-font', async (event, role: unknown) => {
    if (!isTrustedAppearanceSettingsReadEvent(event) || typeof role !== 'string') throwIpcError('INVALID_PARAMS', 'Appearance font reader required');
    const themeFont = await readSelectedThemeFont(role);
    if (themeFont) return themeFont;
    const { readSelectedPluginFont } = await import('./mcp-apps/appearance.js');
    return readSelectedPluginFont(role);
  });

  // Local Desktop appearance only: no remote allowlist and no renderer-supplied path.
  ipcMain.handle('appearance-settings:ensure-wallpaper-video', async (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    const { ensureWallpaperVideo } = await import('./wallpaper-video.js');
    const result = await ensureWallpaperVideo(id, (progress) => {
      event.senderFrame?.send(WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL, progress);
    });
    return result;
  });

  ipcMain.handle('appearance-settings:ensure-wallpaper-image', async (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    const { ensureWallpaperImage } = await import('./wallpaper-video.js');
    return ensureWallpaperImage(id, (progress) => {
      event.senderFrame?.send(WALLPAPER_DOWNLOAD_PROGRESS_CHANNEL, progress);
    });
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
    return updateAppearanceFromSettings(rawPatch);
  });

  ipcMain.handle('appearance-settings:reset', async (event) => {
    assertTrustedAppRendererEvent(event);
    return resetAppearanceFromSettings();
  });

  ipcMain.handle('appearance-settings:select-theme', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const selection = raw === null ? null : parseThemeSelection(raw);
    if (raw !== null && (!selection || !selection.familyId.endsWith(LOCAL_THEME_SUFFIX)))
      throwIpcError('INVALID_PARAMS', 'Invalid theme package selection');
    try {
      const settings = await appearanceService.select(selection);
      publishAppearanceFromOwner(settings);
      return settings;
    } catch { throwIpcError('INTERNAL', 'Unable to prepare theme package'); }
  });
  ipcMain.handle('appearance-settings:reset-fields', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!Array.isArray(raw) || !raw.length || raw.length > APPEARANCE_RESET_FIELDS.length ||
        raw.some(field => !APPEARANCE_RESET_FIELDS.includes(field))) throwIpcError('INVALID_PARAMS', 'Invalid appearance reset');
    const settings = await writeAppearanceSettingsPatch(appearanceResetPatch(raw));
    publishAppearanceFromOwner(settings);
    return settings;
  });
}

export function applyAppearanceToWindow(
  win: BrowserWindow,
  settings: Pick<AppearanceSettings, 'windowZoom'> = readAppearanceSettings(),
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed() || !isAppContentWindow(win)) return;
  win.webContents.setZoomFactor(settings.windowZoom);
  if (process.platform === 'darwin') refreshMacSidebarGeometry(win);
}

export function applyAppearanceToWindows(settings = readAppearanceSettings()): void {
  for (const win of BrowserWindow.getAllWindows()) {
    applyAppearanceToWindow(win, settings);
  }
}

/**
 * Re-asserts the persisted window zoom only when the live zoom has drifted.
 *
 * Chromium persists a zoom level per URL. A window that navigates to a URL with
 * a stale record silently keeps that record instead of the saved preference
 * (#7486). Callers invoke this at points where Chromium can override the zoom.
 */
export function restoreWindowZoom(win: BrowserWindow): void {
  if (!isAppContentWindow(win) || win.webContents.isDestroyed()) return;
  const settings = readAppearanceSettings();
  if (Math.abs(win.webContents.getZoomFactor() - settings.windowZoom) > 0.000001) {
    applyAppearanceToWindow(win, settings);
  }
}

/**
 * Keeps the persisted zoom across in-page navigations.
 *
 * The renderer routes conversations through the URL hash, so `did-finish-load`
 * never fires when the user switches pages. Chromium then restores whatever
 * zoom level it recorded for the new URL, which makes the window shrink or grow
 * until the next full load. Re-assert the preference on every in-page
 * navigation so the saved scale wins.
 */
export function installWindowZoomRestoration(win: BrowserWindow): void {
  win.webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (!isMainFrame || win.isDestroyed() || win.webContents.isDestroyed()) return;
    restoreWindowZoom(win);
  });
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
function appearanceForWindow(
  settings: AppearanceSettings,
  win: BrowserWindow | null,
): AppearanceSettings {
  if (isAppContentWindow(win)) return settings;
  const { customWallpaperUrl: _privateUrl, customWallpaperFallbackUrl: _fallback, ...publicSettings } = settings;
  void _privateUrl; void _fallback;
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
    'terminalFamily',
    'terminalSize',
    'windowZoom',
    'wallpaperId',
    'wallpaperOverlay',
    'wallpaperVisibility',
    'desktopVisibility',
    'wallpaperBlur',
    'wallpaperMotion',
    'appIcon',
    'density',
    'motion',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throwIpcError('INVALID_PARAMS', `unknown appearance field: ${key}`);
  }
  const patch: AppearanceOverrides = {};
  if ('uiFamily' in raw) { patch.uiFamily = parseFamily(raw.uiFamily, 'uiFamily'); patch.uiFontResource = undefined; }
  if ('codeFamily' in raw) { patch.codeFamily = parseFamily(raw.codeFamily, 'codeFamily'); patch.codeFontResource = undefined; }
  if ('terminalFamily' in raw) {
    patch.terminalFamily = parseFamily(raw.terminalFamily, 'terminalFamily');
    patch.terminalFontResource = undefined;
  }
  for (const [key, min, max] of [['density', 0.75, 1.25], ['motion', 0, 2]] as const) {
    if (key in raw) patch[key] = parseNumber(raw[key], key, value => Math.min(max, Math.max(min, value)), { min, max });
  }
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
  if ('terminalSize' in raw)
    patch.terminalSize = parseNumber(
      raw.terminalSize,
      'terminalSize',
      clampAppearanceTerminalSize,
      APPEARANCE_LIMITS.terminalSize,
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
  if ('wallpaperVisibility' in raw) {
    patch.wallpaperVisibility =
      raw.wallpaperVisibility === null
        ? null
        : parseNumber(
            raw.wallpaperVisibility,
            'wallpaperVisibility',
            clampAppearanceWallpaperVisibility,
            APPEARANCE_LIMITS.wallpaperVisibility,
          );
  }
  if ('desktopVisibility' in raw) {
    patch.desktopVisibility =
      raw.desktopVisibility === null
        ? null
        : parseNumber(
            raw.desktopVisibility,
            'desktopVisibility',
            clampAppearanceWallpaperVisibility,
            APPEARANCE_LIMITS.wallpaperVisibility,
          );
  }
  if ('wallpaperBlur' in raw) {
    patch.wallpaperBlur =
      raw.wallpaperBlur === null
        ? null
        : parseNumber(
            raw.wallpaperBlur,
            'wallpaperBlur',
            clampAppearanceWallpaperBlur,
            APPEARANCE_LIMITS.wallpaperBlur,
          );
  }
  if ('appIcon' in raw) {
    if (!isAppIcon(raw.appIcon)) throwIpcError('INVALID_PARAMS', 'appIcon is not supported');
    patch.appIcon = raw.appIcon;
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

/** Plugin settings use the same profile owner and existing window broadcast. */
export function publishAppearanceFromOwner(settings: AppearanceSettings): void {
  applyAppearanceToWindows(settings);
  applyDockIcon(settings);
  broadcast(settings);
}

/** Refresh only a package projection already requested by the renderer. */
export function refreshAppearanceTheme(): Promise<AppearanceSettings> | undefined {
  const preparation = appearanceService.refresh();
  if (!preparation) return undefined;
  const previous = pluginAppearanceRevision(readAppearanceSettings());
  return preparation.then(settings => {
    if (pluginAppearanceRevision(settings) !== previous) publishAppearanceFromOwner(settings);
    return settings;
  });
}

/** UI and Agent edits share validation, persistence, live windows and broadcasts. */
export async function updateAppearanceFromSettings(rawPatch: unknown, options?: { ifRevision?: unknown; assertCurrent?(): void }) {
  const patch = parsePatch(rawPatch);
  const settings = options ? await updateAppearanceSettingsAtomic(() => {
    options.assertCurrent?.();
    if (options.ifRevision !== undefined) {
      if (typeof options.ifRevision !== 'string' || !/^[a-f0-9]{64}$/.test(options.ifRevision)) throw new Error('MCP_APP_INVALID_REQUEST');
      if (options.ifRevision !== pluginAppearanceRevision(readAppearanceSettings())) throw new Error('MCP_APP_APPEARANCE_CHANGED');
    }
    return patch;
  }) : await writeAppearanceSettingsPatch(patch);
  publishAppearanceFromOwner(settings);
  return settings;
}
export async function resetAppearanceFromSettings() {
  const settings = await resetAppearanceSettings();
  publishAppearanceFromOwner(settings);
  return settings;
}
