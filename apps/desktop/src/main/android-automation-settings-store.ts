import { validateOptionalSettingsFields } from './maker-host/settings-inspection.js';
import { inspectSettingsJson } from './maker-host/inspect-settings-json.js';
/**
 * Stores Android automation choices that affect new agent sessions globally.
 *
 * File: <userData>/android-automation-settings.json
 * Defaults keep Android on the automatic path: no pinned device and no custom
 * ADB binary. Persisted values are user overrides only.
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('android-automation-settings-store');

export interface AndroidAutomationSettings {
  defaultDeviceSerial: string | null;
  adbPathOverride: string | null;
}

const DEFAULTS: AndroidAutomationSettings = {
  defaultDeviceSerial: null,
  adbPathOverride: null,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'android-automation-settings.json');
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalize(raw: unknown): AndroidAutomationSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    defaultDeviceSerial: normalizeNullableString(r.defaultDeviceSerial),
    adbPathOverride: normalizeNullableString(r.adbPathOverride),
  };
}

const store = createOverrideSettingsFile<AndroidAutomationSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'android-automation',
});

export function inspectAndroidAutomationSettings(root: string) {
  return inspectSettingsJson(path.join(root, 'android-automation-settings.json'), raw => {
    const nullableString = (value: unknown) => value === null || typeof value === 'string';
    validateOptionalSettingsFields(raw, { defaultDeviceSerial: nullableString, adbPathOverride: nullableString });
    return normalize(raw);
  });
}

export function readAndroidAutomationSettings(): AndroidAutomationSettings {
  return store.read();
}

export function readAndroidAutomationSettingsState(): OverrideSettingsState<AndroidAutomationSettings> {
  return store.readState();
}

export function writeAndroidDefaultDeviceSerial(serial: string | null): AndroidAutomationSettings {
  store.writePatch({ defaultDeviceSerial: normalizeNullableString(serial) });
  return store.read();
}

export function writeAndroidAdbPathOverride(adbPath: string | null): AndroidAutomationSettings {
  store.writePatch({ adbPathOverride: normalizeNullableString(adbPath) });
  return store.read();
}

export function resetAndroidAutomationSettings(): AndroidAutomationSettings {
  return store.reset();
}

export const __testing = { normalize, DEFAULTS };
