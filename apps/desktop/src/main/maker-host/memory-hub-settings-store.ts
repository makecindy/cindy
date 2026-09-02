/**
 * memory-hub-settings-store — Memory Hub 面板自身偏好的 main 端持久化。
 *
 * 文件: <userData>/memory-hub-settings.json
 *   { "backgroundAnalysis": boolean }
 *
 * 刻意独立于 memory-settings.json (maker/claudeCode/codex/pi 开关):
 * 那份文件的读写/重置语义有独立的联动链, Hub 的 UI 偏好不应混入其中。
 * 默认值跟 memory-hub-plan.md §4 的用户裁决对齐: 后台分析默认开,
 * 成本由 delta 触发 + 频率上限兜底。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
} from './override-settings-file.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('memory-hub-settings-store');

export interface MemoryHubSettings {
  backgroundAnalysis: boolean;
}

const DEFAULTS: MemoryHubSettings = {
  backgroundAnalysis: true,
};

function settingsFilePath(rootPath?: string): string {
  return path.join(rootPath ?? app.getPath('userData'), 'memory-hub-settings.json');
}

function normalize(raw: unknown): MemoryHubSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    backgroundAnalysis:
      typeof r.backgroundAnalysis === 'boolean' ? r.backgroundAnalysis : DEFAULTS.backgroundAnalysis,
  };
}

const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<MemoryHubSettings>>>();

function currentStore(rootPath?: string) {
  const ownerRoot = rootPath ?? (getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null);
  const key = ownerRoot ?? '<global>';
  let current = stores.get(key);
  if (!current) {
    current = createOverrideSettingsFile<MemoryHubSettings>({
      filePath: () => settingsFilePath(ownerRoot ?? undefined),
      defaults: DEFAULTS,
      normalize,
      log,
      label: 'memory-hub',
    });
    stores.set(key, current);
  }
  return current;
}

export function readMemoryHubSettings(rootPath?: string): MemoryHubSettings {
  return currentStore(rootPath).read();
}

export function writeMemoryHubSetting(
  patch: Partial<MemoryHubSettings>,
  rootPath?: string,
): MemoryHubSettings {
  currentStore(rootPath).writePatch(patch);
  return currentStore(rootPath).read();
}
