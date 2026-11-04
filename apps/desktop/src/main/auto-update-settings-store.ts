/**
 * auto-update-settings-store —— application update auto-apply settings.
 *
 * File: <userData>/auto-update-settings.json
 *
 * Defaults:
 *  - autoRelaunchOnIdle: false
 *
 * The app may still check and download updates automatically. This setting only
 * controls whether a downloaded update can be applied by relaunching the app
 * after the machine has been idle and no tasks are running.
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  portableOverrideSettings,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('auto-update-settings-store');

export interface AutoUpdateSettings {
  autoRelaunchOnIdle: boolean;
}

const DEFAULTS: AutoUpdateSettings = {
  autoRelaunchOnIdle: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'auto-update-settings.json');
}

function normalize(raw: unknown): AutoUpdateSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    autoRelaunchOnIdle:
      typeof r.autoRelaunchOnIdle === 'boolean'
        ? r.autoRelaunchOnIdle
        : DEFAULTS.autoRelaunchOnIdle,
  };
}

const store = createOverrideSettingsFile<AutoUpdateSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'auto-update',
});

export function readAutoUpdateSettings(): AutoUpdateSettings {
  return store.read();
}

export function readAutoUpdateSettingsState(): OverrideSettingsState<AutoUpdateSettings> {
  return store.readState();
}

export function writeAutoRelaunchOnIdle(autoRelaunchOnIdle: boolean): void {
  store.writePatch({ autoRelaunchOnIdle });
  log.info('auto-update setting written', { autoRelaunchOnIdle });
}

export function resetAutoUpdateSettings(): AutoUpdateSettings {
  return store.reset();
}

export const __testing = { normalize };

/** New-computer setup: values the user changed here (docs/product-rules/new-device-setup-migration.md). */
export const autoUpdatePortableSettings = portableOverrideSettings(store);
