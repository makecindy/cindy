/**
 * Commit attribution preference owned by the main process.
 *
 * File: <userData>/commit-attribution-settings.json
 * Shape: { "enabled": false }
 *
 * The default preserves the existing attribution behavior. Only an explicit
 * override is persisted, so future default changes reach uncustomized users.
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('commit-attribution-settings-store');

export interface CommitAttributionSettings {
  enabled: boolean;
}

const DEFAULTS: CommitAttributionSettings = { enabled: true };

const store = createOverrideSettingsFile<CommitAttributionSettings>({
  filePath: () => path.join(app.getPath('userData'), 'commit-attribution-settings.json'),
  defaults: DEFAULTS,
  normalize: (raw) => ({
    enabled:
      raw && typeof raw === 'object' && typeof (raw as { enabled?: unknown }).enabled === 'boolean'
        ? (raw as { enabled: boolean }).enabled
        : DEFAULTS.enabled,
  }),
  log,
  label: 'commit attribution',
  maxBytes: 4096,
  preserveUnreadableFile: true,
});

export function readCommitAttributionSettings(): CommitAttributionSettings {
  return store.read();
}

export function readCommitAttributionSettingsState(): OverrideSettingsState<CommitAttributionSettings> {
  return store.readState();
}

export function writeCommitAttributionEnabled(
  enabled: boolean,
): OverrideSettingsState<CommitAttributionSettings> {
  store.writePatch({ enabled });
  log.info('commit attribution setting written', { enabled });
  return store.readState();
}

export function resetCommitAttributionSettings(): OverrideSettingsState<CommitAttributionSettings> {
  store.reset();
  return store.readState();
}
