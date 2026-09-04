/**
 * session-title-settings-store —— 动态任务标题开关。
 *
 * File: <userData>/session-title-settings.json
 *
 * Defaults:
 *  - dynamicTitleEnabled: false
 *
 * 开关只控制「turn 收尾后自动更新任务标题」这一行为;关闭时所有刷新路径短路,
 * 不产生任何模型调用(见 maker-ipc/dynamicSessionTitle.ts)。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('session-title-settings-store');

export interface SessionTitleSettings {
  dynamicTitleEnabled: boolean;
}

const DEFAULTS: SessionTitleSettings = {
  dynamicTitleEnabled: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'session-title-settings.json');
}

function normalize(raw: unknown): SessionTitleSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    dynamicTitleEnabled:
      typeof r.dynamicTitleEnabled === 'boolean'
        ? r.dynamicTitleEnabled
        : DEFAULTS.dynamicTitleEnabled,
  };
}

const store = createOverrideSettingsFile<SessionTitleSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'session-title-settings',
});

export function readSessionTitleSettings(): SessionTitleSettings {
  return store.read();
}

export function readSessionTitleSettingsState(): OverrideSettingsState<SessionTitleSettings> {
  return store.readState();
}

export function writeDynamicTitleEnabled(dynamicTitleEnabled: boolean): void {
  store.writePatch({ dynamicTitleEnabled });
  log.info('session title setting written', { dynamicTitleEnabled });
}

export function resetSessionTitleSettings(): SessionTitleSettings {
  return store.reset();
}

export const __testing = { normalize };
