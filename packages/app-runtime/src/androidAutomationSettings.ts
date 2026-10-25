
import path from 'node:path';
import {createOverrideSettingsFile,type OverrideSettingsState} from './overrideSettingsFile.js';
import type {Logger} from '@cindy/maker-core';
export interface createAndroidAutomationSettingsHost { userDataPath():string;log:Logger;}


export interface AndroidAutomationSettings {
  defaultDeviceSerial: string | null;
  adbPathOverride: string | null;
}
export function createAndroidAutomationSettings(host: createAndroidAutomationSettingsHost) {
const {log}=host;




const DEFAULTS: AndroidAutomationSettings = {
  defaultDeviceSerial: null,
  adbPathOverride: null,
};

function settingsFilePath(): string {
  return path.join(host.userDataPath(), 'android-automation-settings.json');
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

function readAndroidAutomationSettings(): AndroidAutomationSettings {
  return store.read();
}

function readAndroidAutomationSettingsState(): OverrideSettingsState<AndroidAutomationSettings> {
  return store.readState();
}

function writeAndroidDefaultDeviceSerial(serial: string | null): AndroidAutomationSettings {
  store.writePatch({ defaultDeviceSerial: normalizeNullableString(serial) });
  return store.read();
}

function writeAndroidAdbPathOverride(adbPath: string | null): AndroidAutomationSettings {
  store.writePatch({ adbPathOverride: normalizeNullableString(adbPath) });
  return store.read();
}

function resetAndroidAutomationSettings(): AndroidAutomationSettings {
  return store.reset();
}

const __testing = { normalize, DEFAULTS };
return {readAndroidAutomationSettings,readAndroidAutomationSettingsState,writeAndroidDefaultDeviceSerial,writeAndroidAdbPathOverride,resetAndroidAutomationSettings,__testing};
}
