/**
 * collaboration-settings-store —— multi-worker 协同模式的 main 端持久化设置。
 *
 * 文件: <userData>/collaboration-settings.json
 *
 * 默认值:
 *  - softLimit: 5
 *  - hardLimit: 8
 *  - idleReleaseMinutes: 0 (disabled)
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  portableOverrideSettings,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('collaboration-settings-store');

export interface CollaborationSettings {
  workerSoftLimit: number;
  workerHardLimit: number;
  workerIdleReleaseMinutes: number;
}

const DEFAULTS: CollaborationSettings = {
  workerSoftLimit: 5,
  workerHardLimit: 8,
  workerIdleReleaseMinutes: 0,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'collaboration-settings.json');
}

function normalize(raw: unknown): CollaborationSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const soft = typeof r.workerSoftLimit === 'number' ? r.workerSoftLimit : DEFAULTS.workerSoftLimit;
  const hard = typeof r.workerHardLimit === 'number' ? r.workerHardLimit : DEFAULTS.workerHardLimit;
  const clampedSoft = clamp(soft, 1, 20);
  return {
    workerSoftLimit: clampedSoft,
    workerHardLimit: clamp(hard, clampedSoft, 20),
    workerIdleReleaseMinutes:
      typeof r.workerIdleReleaseMinutes === 'number'
        ? clamp(r.workerIdleReleaseMinutes, 0, 120)
        : DEFAULTS.workerIdleReleaseMinutes,
  };
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

const store = createOverrideSettingsFile<CollaborationSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'collaboration',
});

export function readCollaborationSettings(): CollaborationSettings {
  return store.read();
}

export function readCollaborationSettingsState(): OverrideSettingsState<CollaborationSettings> {
  return store.readState();
}

export function writeCollaborationSetting<K extends keyof CollaborationSettings>(
  key: K,
  value: CollaborationSettings[K],
): void {
  store.writePatch({ [key]: value } as Partial<CollaborationSettings>);
  log.info('collaboration setting written', { key, value });
}

export function resetCollaborationSettings(): CollaborationSettings {
  return store.reset();
}

export const __testing = { normalize };

/** New-computer setup: values the user changed here (docs/product-rules/new-device-setup-migration.md). */
export const collaborationPortableSettings = portableOverrideSettings(store);
