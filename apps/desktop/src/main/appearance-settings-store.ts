import { app } from 'electron';
import path from 'node:path';

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
  return store.read();
}

export function readAppearanceSettingsState(): OverrideSettingsState<AppearanceSettings> {
  return store.readState();
}

export async function writeAppearanceSettingsPatch(
  patch: AppearanceOverrides,
): Promise<AppearanceSettings> {
  await store.writePatchAtomic(patch);
  return store.read();
}

export async function updateAppearanceSettingsAtomic(
  updater: (current: AppearanceSettings) => AppearanceOverrides,
): Promise<AppearanceSettings> {
  return store.updateAtomic((current) => updater(current.value));
}

export async function resetAppearanceSettings(): Promise<AppearanceSettings> {
  return store.resetAtomic();
}

export const __testing = {
  normalize: normalizeAppearanceSettings,
  settingsFilePath,
};
