import { app } from 'electron';
import path from 'node:path';

import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';

export const DEFAULT_DATABASE_SIZE_WARNING_THRESHOLD_GIB = 10;
const MIN_THRESHOLD_GIB = 1;
const MAX_THRESHOLD_GIB = 1024;

export interface DatabaseSizeWarningSettings {
  thresholdGiB: number;
  disabled: boolean;
}

export type DatabaseSizeWarningSettingsPatch = Partial<DatabaseSizeWarningSettings>;

export type DatabaseSizeWarningSettingsPatchParseResult =
  | { patch: DatabaseSizeWarningSettingsPatch }
  | { error: string };

export function parseDatabaseSizeWarningSettingsPatch(
  raw: unknown,
): DatabaseSizeWarningSettingsPatchParseResult {
  if (!raw || typeof raw !== 'object') {
    return { error: 'database size warning settings payload required' };
  }
  const value = raw as Record<string, unknown>;
  const patch: DatabaseSizeWarningSettingsPatch = {};
  if (value.thresholdGiB !== undefined) {
    if (
      typeof value.thresholdGiB !== 'number' ||
      !Number.isFinite(value.thresholdGiB) ||
      value.thresholdGiB < MIN_THRESHOLD_GIB ||
      value.thresholdGiB > MAX_THRESHOLD_GIB
    ) {
      return { error: 'thresholdGiB must be between 1 and 1024' };
    }
    patch.thresholdGiB = value.thresholdGiB;
  }
  if (value.disabled !== undefined) {
    if (typeof value.disabled !== 'boolean') {
      return { error: 'disabled must be a boolean' };
    }
    patch.disabled = value.disabled;
  }
  if (Object.keys(patch).length === 0) {
    return { error: 'at least one setting is required' };
  }
  return { patch };
}

const DEFAULTS: DatabaseSizeWarningSettings = {
  thresholdGiB: DEFAULT_DATABASE_SIZE_WARNING_THRESHOLD_GIB,
  disabled: false,
};

const log = createLogger('database-size-warning');

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'database-size-warning-settings.json');
}

function normalize(raw: unknown): DatabaseSizeWarningSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const value = raw as Record<string, unknown>;
  const thresholdGiB =
    typeof value.thresholdGiB === 'number' &&
    Number.isFinite(value.thresholdGiB) &&
    value.thresholdGiB >= MIN_THRESHOLD_GIB &&
    value.thresholdGiB <= MAX_THRESHOLD_GIB
      ? value.thresholdGiB
      : DEFAULTS.thresholdGiB;
  return {
    thresholdGiB,
    disabled: typeof value.disabled === 'boolean' ? value.disabled : DEFAULTS.disabled,
  };
}

const store = createOverrideSettingsFile<DatabaseSizeWarningSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'database-size-warning',
});

export function readDatabaseSizeWarningSettings(): DatabaseSizeWarningSettings {
  return store.read();
}

export function readDatabaseSizeWarningSettingsState(): OverrideSettingsState<DatabaseSizeWarningSettings> {
  return store.readState();
}

export function writeDatabaseSizeWarningSettings(
  patch: Partial<DatabaseSizeWarningSettings>,
): DatabaseSizeWarningSettings {
  store.writePatch(patch);
  return store.read();
}

export const __testing = { normalize, DEFAULTS, MIN_THRESHOLD_GIB, MAX_THRESHOLD_GIB };
