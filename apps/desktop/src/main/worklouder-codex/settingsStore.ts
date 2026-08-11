/** Main-process persistence for Work Louder Codex Micro device preferences. */

import { app } from 'electron';
import path from 'node:path';

import {
  WORKLOUDER_CODEX_DEFAULT_SETTINGS,
  isWorkLouderCodexAutoDim,
  type WorkLouderCodexSettings,
  type WorkLouderCodexSettingsPatch,
} from '../../shared/workLouderCodex.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('worklouder-codex-settings-store');

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'worklouder-codex-settings.json');
}

function normalize(raw: unknown): WorkLouderCodexSettings {
  if (!raw || typeof raw !== 'object') return { ...WORKLOUDER_CODEX_DEFAULT_SETTINGS };
  const value = raw as Record<string, unknown>;
  const brightness = value.lightingBrightness;
  return {
    lightingBrightness:
      typeof brightness === 'number' && Number.isFinite(brightness)
        ? Math.max(0, Math.min(100, Math.round(brightness)))
        : WORKLOUDER_CODEX_DEFAULT_SETTINGS.lightingBrightness,
    lightingAutoDim: isWorkLouderCodexAutoDim(value.lightingAutoDim)
      ? value.lightingAutoDim
      : WORKLOUDER_CODEX_DEFAULT_SETTINGS.lightingAutoDim,
    singleTapAgentKeys:
      typeof value.singleTapAgentKeys === 'boolean'
        ? value.singleTapAgentKeys
        : WORKLOUDER_CODEX_DEFAULT_SETTINGS.singleTapAgentKeys,
  };
}

const store = createOverrideSettingsFile<WorkLouderCodexSettings>({
  filePath: settingsFilePath,
  defaults: WORKLOUDER_CODEX_DEFAULT_SETTINGS,
  normalize,
  log,
  label: 'worklouder-codex',
});

export function readWorkLouderCodexSettings(): WorkLouderCodexSettings {
  return store.read();
}

export function writeWorkLouderCodexSettingsPatch(
  patch: WorkLouderCodexSettingsPatch,
): WorkLouderCodexSettings {
  store.writePatch(patch);
  log.info('Work Louder Codex settings written', { keys: Object.keys(patch) });
  return store.read();
}

export const __testing = { normalize };
