
import path from 'node:path';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './overrideSettingsFile.js';
import type { DbLogger } from '@cindy/runtime-db/logging';


export interface CollaborationSettings {
  workerSoftLimit: number;
  workerHardLimit: number;
  workerIdleReleaseMinutes: number;
}
export function createCollaborationSettingsStore(host: { userDataDirectory(): string; logger: DbLogger }) {
const log = host.logger;


const DEFAULTS: CollaborationSettings = {
  workerSoftLimit: 5,
  workerHardLimit: 8,
  workerIdleReleaseMinutes: 0,
};

function settingsFilePath(): string {
  return path.join(host.userDataDirectory(), 'collaboration-settings.json');
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

function readCollaborationSettings(): CollaborationSettings {
  return store.read();
}

function readCollaborationSettingsState(): OverrideSettingsState<CollaborationSettings> {
  return store.readState();
}

function writeCollaborationSetting<K extends keyof CollaborationSettings>(
  key: K,
  value: CollaborationSettings[K],
): void {
  store.writePatch({ [key]: value } as Partial<CollaborationSettings>);
  log.info('collaboration setting written', { key, value });
}

function resetCollaborationSettings(): CollaborationSettings {
  return store.reset();
}

const __testing = { normalize };
return {
  readCollaborationSettings,
  readCollaborationSettingsState,
  writeCollaborationSetting,
  resetCollaborationSettings,
  __testing
};
}
