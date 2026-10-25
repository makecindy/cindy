import type {AndroidAdbPreparationState,AndroidMcpErrorCode,AndroidStatusSummary} from '@cindy/mcps';
import type {OverrideSettingsState} from './overrideSettingsFile.js';
import type {AndroidAutomationSettings} from './androidAutomationSettings.js';
import {throwIpcError} from '@cindy/remote-agent/ipcValidate';
import {MAKER_INVOKE} from '@cindy/maker-shared/maker-channels';
import type {IpcHandlerRegistry} from './ipcHandlerRegistry.js';


type AndroidStatusToolResult =
  | { ok: true; data: AndroidStatusSummary }
  | {
      ok: false;
      errorCode: AndroidMcpErrorCode;
      message: string;
      data?: Record<string, unknown>;
    };

export interface AndroidAutomationHandlerDeps {
  getStatusSummary(): Promise<AndroidStatusToolResult>;
  getSettingsState(): OverrideSettingsState<AndroidAutomationSettings>;
  setDefaultDeviceSerial(serial: string | null): AndroidAutomationSettings;
  setAdbPathOverride(path: string | null): AndroidAutomationSettings;
  prepareAdb(): Promise<AndroidAdbPreparationState>;
}

function failedAndroidStatus(
  result: Extract<AndroidStatusToolResult, { ok: false }>,
): AndroidStatusSummary {
  const data = result.data ?? {};
  return {
    adb_available: false,
    adb_path: null,
    adb_path_source: typeof data.adb_path_source === 'string'
      ? data.adb_path_source as AndroidStatusSummary['adb_path_source']
      : null,
    version: null,
    devices: [],
    default_device_serial: null,
    configured_default_device_serial: typeof data.configured_default_device_serial === 'string'
      ? data.configured_default_device_serial
      : null,
    issue: result.errorCode,
    error: result.message,
    ...(data.adb_preparation && typeof data.adb_preparation === 'object'
      ? { adb_preparation: data.adb_preparation as AndroidAdbPreparationState }
      : {}),
  };
}

export function normalizeAndroidStatusResult(
  result: AndroidStatusToolResult,
): AndroidStatusSummary {
  return result.ok ? result.data : failedAndroidStatus(result);
}

function readNullableStringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') {
    throwIpcError('INVALID_PARAMS', 'payload must be an object');
  }
  const value = (payload as Record<string, unknown>)[key];
  if (value === null) return null;
  if (typeof value === 'string') return value.trim() || null;
  throwIpcError('INVALID_PARAMS', `${key} must be a string or null`);
}

export function registerAndroidAutomationHandlers(
  registry: IpcHandlerRegistry,
  deps: AndroidAutomationHandlerDeps,
): void {
  const resolvedDeps = deps;
  registry.handle(MAKER_INVOKE.ANDROID_STATUS, async () => {
    try {
      return normalizeAndroidStatusResult(await resolvedDeps.getStatusSummary());
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(MAKER_INVOKE.ANDROID_GET_CONFIG, async () => {
    try {
      return resolvedDeps.getSettingsState();
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(MAKER_INVOKE.ANDROID_SET_DEFAULT_DEVICE, async (_event, payload) => {
    try {
      const value = readNullableStringField(payload, 'defaultDeviceSerial');
      resolvedDeps.setDefaultDeviceSerial(value);
      return resolvedDeps.getSettingsState();
    } catch (err) {
      if ((err as { code?: string }).code === 'INVALID_PARAMS') throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(MAKER_INVOKE.ANDROID_SET_ADB_PATH, async (_event, payload) => {
    try {
      const value = readNullableStringField(payload, 'adbPathOverride');
      resolvedDeps.setAdbPathOverride(value);
      return resolvedDeps.getSettingsState();
    } catch (err) {
      if ((err as { code?: string }).code === 'INVALID_PARAMS') throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(MAKER_INVOKE.ANDROID_PREPARE_ADB, async () => {
    try {
      return resolvedDeps.prepareAdb();
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });
}