/**
 * shared-global-skills-settings —— 全局 Skill 跨 Agent 链接的显式 opt-in。
 *
 * File: <userData>/shared-global-skills-settings.json
 *   { "crossAgentSyncEnabled": true }
 *
 * Default off（#2930）：默认不跨 Agent 修改任何全局 Skill 根，共享必须由用户显式
 * opt-in。文件只存被改过的字段，未改过的字段随未来默认值变化流动。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('shared-global-skills-settings');

export interface SharedGlobalSkillsSettings {
  crossAgentSyncEnabled: boolean;
}

const DEFAULTS: SharedGlobalSkillsSettings = {
  crossAgentSyncEnabled: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'shared-global-skills-settings.json');
}

function normalize(raw: unknown): SharedGlobalSkillsSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    crossAgentSyncEnabled:
      typeof r.crossAgentSyncEnabled === 'boolean'
        ? r.crossAgentSyncEnabled
        : DEFAULTS.crossAgentSyncEnabled,
  };
}

const store = createOverrideSettingsFile<SharedGlobalSkillsSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'shared global skills',
});

export function readSharedGlobalSkillsSettings(): SharedGlobalSkillsSettings {
  // 隐藏配置约定：直接改文件也是正式 opt-in 入口，读取前按 mtime 失效缓存，
  // 否则运行期间写入 crossAgentSyncEnabled 仍会读到旧值直到重启（review P2）。
  store.invalidateIfChanged();
  return store.read();
}

export function readSharedGlobalSkillsSettingsState(): OverrideSettingsState<SharedGlobalSkillsSettings> {
  store.invalidateIfChanged();
  return store.readState();
}
