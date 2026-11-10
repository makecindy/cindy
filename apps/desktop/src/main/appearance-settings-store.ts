import { app } from 'electron';
import path from 'node:path';
import { readCustomWallpaperUrl, customWallpaperStore, configureAppearanceWallpaperReferences } from './custom-wallpaper-settings.js';
import { AppearanceService } from './appearance/service.js';
import { resolveThemeAppearance, readThemeFont } from './appearance/themes.js';
import { isPluginFontResource } from '../shared/pluginAppearance.js';
import { recycleAppearanceWallpapers } from './custom-wallpaper.js';

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
  mergeOverrides: ({ patch, next, defaults, overrides }) => {
    const result = { ...overrides };
    for (const key of Object.keys(patch) as Array<keyof AppearanceSettings>) {
      if (patch[key] === undefined || patch[key] === null ||
          key !== 'themeSelection' && !next.themeSelection && JSON.stringify(next[key]) === JSON.stringify(defaults[key])) delete result[key];
      else result[key] = next[key];
    }
    return result;
  },
  log,
  label: 'appearance',
  maxBytes: 16 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});

export const appearanceService = new AppearanceService({ store, resolveTheme: resolveThemeAppearance,
  wallpaper: () => ({ url: readCustomWallpaperUrl(), fallbackUrl: customWallpaperStore.read().fallbackUrl }),
  cleanupMedia: recycleAppearanceWallpapers,
});
configureAppearanceWallpaperReferences(() => appearanceService.referencedWallpapers());

export function readAppearanceSettings(): AppearanceSettings {
  return appearanceService.read();
}

export function readAppearanceSettingsState(): OverrideSettingsState<AppearanceSettings> {
  return appearanceService.readState();
}

export async function writeAppearanceSettingsPatch(
  patch: AppearanceOverrides,
): Promise<AppearanceSettings> {
  return appearanceService.patch(patch);
}

export async function updateAppearanceSettingsAtomic(
  updater: (current: AppearanceSettings, overrides: AppearanceOverrides) => AppearanceOverrides,
): Promise<AppearanceSettings> {
  return appearanceService.update(updater);
}

export async function resetAppearanceSettings(): Promise<AppearanceSettings> {
  return appearanceService.reset();
}

export const migrateAppearanceThemeSelection = (selection: unknown) => appearanceService.select(selection, true);
export function readSelectedThemeFont(role: string) {
  if (!['uiFont', 'codeFont', 'bodyFont', 'terminalFont'].includes(role)) throw new Error('INVALID_PARAMS');
  const resource = readAppearanceSettings()[`${role}Resource` as 'uiFontResource'];
  return resource && !isPluginFontResource(resource) ? readThemeFont(resource) : null;
}

export const __testing = {
  normalize: normalizeAppearanceSettings,
  settingsFilePath,
};

/** New-computer setup: values the user changed here (docs/product-rules/new-device-setup-migration.md). */
export const appearancePortableSettings = portableOverrideSettings(store, {
  // Host-owned media reference; a custom wallpaper image is not copied.
  omitKeys: ['customWallpaperUrl', 'customWallpaperFallbackUrl', 'uiFontResource', 'codeFontResource', 'bodyFontResource', 'terminalFontResource', 'themeSelection'],
  optionalKeys: ['wallpaperBlur', 'wallpaperVisibility', 'desktopVisibility'],
  filter: (values) => {
    if (values.wallpaperId !== 'custom') return values;
    const rest = { ...values };
    delete rest.wallpaperId;
    return rest;
  },
});
