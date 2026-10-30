import { app } from 'electron';
import path from 'node:path';
import { readCustomWallpaperUrl } from './custom-wallpaper-settings.js';

import {
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearanceSettings,
  type AppearanceOverrides,
  type AppearanceSettings,
} from '../shared/appearanceSettings.js';
import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('appearance-settings-store');

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'appearance-settings.json');
}

const store = createOverrideSettingsFile<AppearanceSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULT_APPEARANCE_SETTINGS,
  normalize: normalizeAppearanceSettings,
  log,
  label: 'appearance',
  maxBytes: 16 * 1024,
  preserveUnreadableFile: true,
});

export function readAppearanceSettings(): AppearanceSettings {
  const value = store.read();
  const customWallpaperUrl = readCustomWallpaperUrl();
  return {
    ...value,
    customWallpaperUrl,
    wallpaperId: value.wallpaperId === 'custom' && !customWallpaperUrl ? 'none' : value.wallpaperId,
  };
}

export function readAppearanceSettingsState(): OverrideSettingsState<AppearanceSettings> {
  return { ...store.readState(), value: readAppearanceSettings() };
}

export async function writeAppearanceSettingsPatch(
  patch: AppearanceOverrides,
): Promise<AppearanceSettings> {
  await store.writePatchAtomic(patch);
  return readAppearanceSettings();
}

export async function updateAppearanceSettingsAtomic(
  updater: (current: AppearanceSettings) => AppearanceOverrides,
): Promise<AppearanceSettings> {
  await store.updateAtomic((current) => updater(current.value));
  return readAppearanceSettings();
}

export async function resetAppearanceSettings(): Promise<AppearanceSettings> {
  await store.resetAtomic();
  return readAppearanceSettings();
}

export const __testing = {
  normalize: normalizeAppearanceSettings,
  settingsFilePath,
};
