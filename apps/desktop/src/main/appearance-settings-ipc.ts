import { BrowserWindow, ipcMain } from 'electron';

import {
  APPEARANCE_LIMITS,
  clampAppearanceCodeSize,
  clampAppearanceUiSize,
  clampAppearanceWindowZoom,
  type AppearanceOverrides,
  type AppearanceSettings,
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
import {
  importAppearanceBackground,
  removeAppearanceBackgroundFile,
  removeAppearanceBackgroundFiles,
} from './appearance-background.js';
import { desktopMakerLogger } from './maker-host/logger-adapter.js';

export { writeAppearanceSettingsPatch } from './appearance-settings-store.js';

export const APPEARANCE_SETTINGS_CHANGED_CHANNEL = 'appearance-settings:changed';

const log = desktopMakerLogger.child('appearance-settings-ipc');
let registered = false;
let backgroundMutationQueue: Promise<void> = Promise.resolve();

function serializeBackgroundMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = backgroundMutationQueue.then(operation, operation);
  backgroundMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function registerAppearanceSettingsIpc(): void {
  if (registered) return;
  registered = true;

  // Must be registered before BrowserWindow creation: preload reads this on
  // the first synchronous bootstrap frame.
  ipcMain.on('appearance-settings:get-sync', (event) => {
    event.returnValue = isTrustedAppearanceSettingsReadEvent(event)
      ? readAppearanceSettings()
      : null;
  });

  ipcMain.handle('appearance-settings:get', (event) => {
    assertTrustedAppRendererEvent(event);
    return readAppearanceSettingsState();
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
    return serializeBackgroundMutation(async () => {
      const settings = await resetAppearanceSettings();
      applyAppearanceToWindows(settings);
      broadcast(settings);
      await cleanupBackgroundFiles(removeAppearanceBackgroundFiles(), 'background reset cleanup');
      return settings;
    });
  });

  ipcMain.handle('appearance-settings:background-import', async (event) => {
    assertTrustedAppRendererEvent(event);
    return serializeBackgroundMutation(async () => {
      const result = await importAppearanceBackground(BrowserWindow.fromWebContents(event.sender));
      if (result.canceled) return result;
      let settings: AppearanceSettings;
      try {
        settings = await writeAppearanceSettingsPatch({ backgroundImage: result.url });
      } catch (error) {
        await cleanupBackgroundFiles(
          removeAppearanceBackgroundFile(result.url),
          'staged background rollback',
        );
        throw error;
      }
      broadcast(settings);
      await cleanupBackgroundFiles(
        removeAppearanceBackgroundFiles(result.url),
        'stale background cleanup',
      );
      return { ...result, settings };
    });
  });

  ipcMain.handle('appearance-settings:background-remove', async (event) => {
    assertTrustedAppRendererEvent(event);
    return serializeBackgroundMutation(async () => {
      const settings = await writeAppearanceSettingsPatch({ backgroundImage: '' });
      broadcast(settings);
      await cleanupBackgroundFiles(removeAppearanceBackgroundFiles(), 'background removal cleanup');
      return settings;
    });
  });
}

async function cleanupBackgroundFiles(operation: Promise<void>, context: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    log.warn(`${context} failed (non-fatal)`, {
      code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN',
    });
  }
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

function broadcast(settings: AppearanceSettings): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isTrustedAppearanceSettingsReadWindow(win)) continue;
    try {
      win.webContents.send(APPEARANCE_SETTINGS_CHANGED_CHANNEL, settings);
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
    'backgroundOverlay',
    'backgroundBlur',
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
  if ('backgroundOverlay' in raw) {
    patch.backgroundOverlay = parseNumber(
      raw.backgroundOverlay,
      'backgroundOverlay',
      (value) => Math.min(0.9, Math.max(0.2, value)),
      APPEARANCE_LIMITS.backgroundOverlay,
    );
  }
  if ('backgroundBlur' in raw) {
    patch.backgroundBlur = parseNumber(
      raw.backgroundBlur,
      'backgroundBlur',
      (value) => Math.round(Math.min(24, Math.max(0, value))),
      APPEARANCE_LIMITS.backgroundBlur,
    );
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
