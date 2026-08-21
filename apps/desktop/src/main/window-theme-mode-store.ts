import { app, nativeTheme } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { isAppThemeMode, type AppThemeMode } from './resolved-app-theme.js';

const log = desktopMakerLogger.child('window-theme-mode-store');

// Renderer localStorage remains the source of truth. This small main-side snapshot exists only so
// Windows can choose the matching Acrylic backing before the first BrowserWindow is created.

export interface WindowThemeSnapshot {
  mode: AppThemeMode;
  resolvedIsDark?: boolean;
  systemIsDark?: boolean;
}

const DEFAULTS: WindowThemeSnapshot = { mode: 'system' };

function normalize(raw: unknown): WindowThemeSnapshot {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const value = raw as Record<string, unknown>;
  const normalized: WindowThemeSnapshot = {
    mode: isAppThemeMode(value.mode) ? value.mode : DEFAULTS.mode,
  };
  if (typeof value.resolvedIsDark === 'boolean') {
    normalized.resolvedIsDark = value.resolvedIsDark;
  }
  if (typeof value.systemIsDark === 'boolean') {
    normalized.systemIsDark = value.systemIsDark;
  }
  return normalized;
}

function resolveSnapshotForSystem(
  snapshot: WindowThemeSnapshot,
  currentSystemIsDark: boolean,
): WindowThemeSnapshot {
  if (snapshot.mode !== 'system') return snapshot;
  if (
    snapshot.resolvedIsDark !== undefined
    && snapshot.systemIsDark === currentSystemIsDark
  ) {
    return {
      ...snapshot,
      mode: snapshot.resolvedIsDark ? 'dark' : 'light',
    };
  }
  const { resolvedIsDark: _staleResolvedTheme, ...currentSystemSnapshot } = snapshot;
  return currentSystemSnapshot;
}

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'window-theme-mode.json');
}

const store = createOverrideSettingsFile<WindowThemeSnapshot>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'window-theme-mode',
  maxBytes: 4 * 1024,
  preserveUnreadableFile: true,
});

export function readWindowThemeSnapshot(): WindowThemeSnapshot {
  return resolveSnapshotForSystem(store.read(), nativeTheme.shouldUseDarkColors);
}

export function writeWindowThemeSnapshot(mode: AppThemeMode, resolvedIsDark: boolean): void {
  try {
    const systemIsDark = nativeTheme.shouldUseDarkColors;
    const current = store.read();
    if (
      current.mode === mode
      && current.resolvedIsDark === resolvedIsDark
      && current.systemIsDark === systemIsDark
    ) return;
    store.writePatch({ mode, resolvedIsDark, systemIsDark });
  } catch (error) {
    // Theme rendering must remain available even if the best-effort restart mirror cannot persist.
    log.warn('window theme mode write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const __testing = { normalize, resolveSnapshotForSystem };
