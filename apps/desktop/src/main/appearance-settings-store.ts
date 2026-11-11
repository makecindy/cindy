import { app } from 'electron';
import path from 'node:path';
import { readCustomWallpaperUrl, customWallpaperStore } from './custom-wallpaper-settings.js';

import {
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearanceSettings,
  type AppearanceOverrides,
  type AppearanceSettings,
} from '../shared/appearanceSettings.js';
import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  portableOverrideSettings,
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
  logLoadedValue: false,
  logReadErrorDetails: false,
});

export function readAppearanceSettings(): AppearanceSettings {
  const value = store.read();
  const customWallpaperUrl = readCustomWallpaperUrl();
  return {
    ...value,
    customWallpaperUrl,
    ...(customWallpaperStore.read().fallbackUrl ? { customWallpaperFallbackUrl: customWallpaperStore.read().fallbackUrl } : {}),
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

/** New-computer setup: values the user changed here (docs/product-rules/new-device-setup-migration.md). */
const portableAppearance = portableOverrideSettings(store, {
  // Host-owned media reference; a custom wallpaper image is not copied.
  omitKeys: ['customWallpaperUrl', 'customWallpaperFallbackUrl', 'uiFontResource', 'codeFontResource', 'bodyFontResource'],
  optionalKeys: ['wallpaperBlur', 'wallpaperVisibility', 'desktopVisibility'],
  filter: (values) => {
    if (values.wallpaperId !== 'custom') return values;
    const rest = { ...values };
    delete rest.wallpaperId;
    return rest;
  },
});

export const appearancePortableSettings = {
  ...portableAppearance,
  readCustomized() {
    // Omit device-local families together with their resource pointers on export.
    // Keep applyPatch's original local-choice conflict guard unchanged.
    const values = portableAppearance.readCustomized(), current = store.read();
    if (current.uiFontResource && values.uiFamily === current.uiFontResource.family) delete values.uiFamily;
    if (current.codeFontResource && values.codeFamily === current.codeFontResource.family) delete values.codeFamily;
    const bodyFont = values.bodyFont as AppearanceSettings['bodyFont'];
    if (current.bodyFontResource && bodyFont?.family === current.bodyFontResource.family) {
      const { family: _family, ...traits } = bodyFont;
      if (Object.keys(traits).length) values.bodyFont = traits;
      else delete values.bodyFont;
    }
    return values;
  },
};
