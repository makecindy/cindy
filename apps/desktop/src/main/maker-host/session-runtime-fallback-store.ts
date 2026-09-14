import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('session-runtime-fallback-store');

export interface SessionRuntimeFallbackSettings {
  enabled: boolean;
}

const DEFAULTS: SessionRuntimeFallbackSettings = { enabled: false };

const store = createOverrideSettingsFile<SessionRuntimeFallbackSettings>({
  filePath: () => path.join(app.getPath('userData'), 'session-runtime-fallback-settings.json'),
  defaults: DEFAULTS,
  normalize: (raw) => ({
    enabled:
      raw && typeof raw === 'object' && typeof (raw as { enabled?: unknown }).enabled === 'boolean'
        ? (raw as { enabled: boolean }).enabled
        : DEFAULTS.enabled,
  }),
  log,
  label: 'session runtime fallback',
});

export function readSessionRuntimeFallbackSettings(): SessionRuntimeFallbackSettings {
  return store.read();
}

export function readSessionRuntimeFallbackSettingsState(): OverrideSettingsState<SessionRuntimeFallbackSettings> {
  return store.readState();
}

export function writeSessionRuntimeFallbackEnabled(enabled: boolean): void {
  store.writePatch({ enabled });
}

export function resetSessionRuntimeFallbackSettings(): SessionRuntimeFallbackSettings {
  return store.reset();
}
