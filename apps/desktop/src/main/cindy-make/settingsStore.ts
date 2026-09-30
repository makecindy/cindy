import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import {
  DEFAULT_CINDY_MAKE_SETTINGS,
  type CindyMakeSettings,
} from '../../shared/cindyMakeSettings.js';

const log = desktopMakerLogger.child('cindy-make-settings-store');

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'cindy-make-settings.json');
}

function normalize(raw: unknown): CindyMakeSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_CINDY_MAKE_SETTINGS };
  }
  const value = raw as Record<string, unknown>;
  return {
    syncLatestBeforeBuild:
      typeof value.syncLatestBeforeBuild === 'boolean'
        ? value.syncLatestBeforeBuild
        : DEFAULT_CINDY_MAKE_SETTINGS.syncLatestBeforeBuild,
  };
}

const store = createOverrideSettingsFile<CindyMakeSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULT_CINDY_MAKE_SETTINGS,
  normalize,
  log,
  label: 'cindy-make',
});

export function readCindyMakeSettings(): CindyMakeSettings {
  return store.read();
}

export function writeCindyMakeSyncLatestBeforeBuild(
  syncLatestBeforeBuild: boolean,
): CindyMakeSettings {
  // An explicit OFF remains an override if the product default changes later.
  store.writePatch({ syncLatestBeforeBuild }, { preserveDefaults: true });
  log.info('Cindy Make build sync setting written', { syncLatestBeforeBuild });
  return store.read();
}

export function resetCindyMakeSettings(): CindyMakeSettings {
  return store.reset();
}

export const __testing = { normalize };
