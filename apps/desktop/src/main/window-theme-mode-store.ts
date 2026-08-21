import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { isAppThemeMode, type AppThemeMode } from './resolved-app-theme.js';

const log = desktopMakerLogger.child('window-theme-mode-store');

// Renderer localStorage remains the source of truth. This small main-side mirror exists only so
// Windows can choose the matching Acrylic backing before the first BrowserWindow is created.

interface WindowThemeModeSettings {
  mode: AppThemeMode;
}

const DEFAULTS: WindowThemeModeSettings = { mode: 'system' };

function normalize(raw: unknown): WindowThemeModeSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const mode = (raw as Record<string, unknown>).mode;
  return { mode: isAppThemeMode(mode) ? mode : DEFAULTS.mode };
}

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'window-theme-mode.json');
}

const store = createOverrideSettingsFile<WindowThemeModeSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'window-theme-mode',
  maxBytes: 4 * 1024,
  preserveUnreadableFile: true,
});

export function readWindowThemeMode(): AppThemeMode {
  return store.read().mode;
}

export function writeWindowThemeMode(mode: AppThemeMode): void {
  try {
    if (store.read().mode === mode) return;
    store.writePatch({ mode });
  } catch (error) {
    // Theme rendering must remain available even if the best-effort restart mirror cannot persist.
    log.warn('window theme mode write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const __testing = { normalize };
