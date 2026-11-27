/**
 * Main-side kill switch for the silent-stop auto-resume guard.
 *
 * File: <userData>/silent-stop-auto-resume-settings.json
 * Shape: { "enabled": true }
 *
 * 默认开启:上游偶发用空内容 assistant 消息静默收尾"干到一半"的 turn(社区同型
 * anthropics/claude-code#50597 / #38905),守卫检测后自动补发「继续」接续任务。
 * 本开关是守卫自身出问题时的逃生门(隐藏配置,不进 Settings UI;规则 20 的
 * "隐藏配置"层级),用户可通过 agent 改本地配置文件关闭。
 */
import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  portableOverrideSettings,
  type OverrideSettingsState,
} from './override-settings-file.js';
import {
  SILENT_STOP_AUTO_RESUME_DEFAULTS as DEFAULTS,
  normalizeSilentStopAutoResumeSettings as normalize,
  readSilentStopAutoResumeSettingsFrom,
  SILENT_STOP_AUTO_RESUME_SETTINGS_FILE,
  type SilentStopAutoResumeSettings,
} from './silentStopAutoResumeSettingsCore.js';

export type { SilentStopAutoResumeSettings } from './silentStopAutoResumeSettingsCore.js';

const log = desktopMakerLogger.child('silent-stop-auto-resume-store');

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), SILENT_STOP_AUTO_RESUME_SETTINGS_FILE);
}

const store = createOverrideSettingsFile<SilentStopAutoResumeSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'silent stop auto resume',
});

export function readSilentStopAutoResumeSettings(): SilentStopAutoResumeSettings {
  return readSilentStopAutoResumeSettingsFrom(app.getPath('userData'));
}

export function readSilentStopAutoResumeSettingsState(): OverrideSettingsState<SilentStopAutoResumeSettings> {
  return store.readState();
}

export function writeSilentStopAutoResumeEnabled(enabled: boolean): void {
  store.writePatch({ enabled });
  log.info('silent stop auto resume setting written', { enabled });
}

export function resetSilentStopAutoResumeSettings(): SilentStopAutoResumeSettings {
  return store.reset();
}

/** New-computer setup: values the user changed here (docs/product-rules/new-device-setup-migration.md). */
export const silentStopAutoResumePortableSettings = portableOverrideSettings(store);
