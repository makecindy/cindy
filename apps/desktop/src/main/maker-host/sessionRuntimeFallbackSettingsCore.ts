import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('session-runtime-fallback-store');

export interface SessionRuntimeFallbackSettings {
  enabled: boolean;
}

const DEFAULTS: SessionRuntimeFallbackSettings = { enabled: false };

/** The settings file in the profile root (the desktop's userData) given by the caller. */
export function createSessionRuntimeFallbackSettingsFile(userDataDir: () => string) {
  return createOverrideSettingsFile<SessionRuntimeFallbackSettings>({
    filePath: () => path.join(userDataDir(), 'session-runtime-fallback-settings.json'),
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
}
