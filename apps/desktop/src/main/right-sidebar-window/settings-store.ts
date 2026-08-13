/**
 * right-sidebar-window 进程内状态。
 *
 * detached / lastOpen 只服务当前客户端进程，用于窗口状态机和隐藏复用；客户端重启后
 * 一律回到主窗口。启动时还会删除旧版本留下的分离偏好文件，避免继续恢复历史状态。
 * 窗口尺寸与位置由独立的 window-state 文件管理，不受这里影响。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { desktopMakerLogger } from '../maker-host/logger-adapter.js';

const log = desktopMakerLogger.child('right-sidebar-window-settings-store');

export interface RsbWindowSettings {
  detached: boolean;
  lastOpen: boolean;
}

const DEFAULTS: RsbWindowSettings = {
  detached: false,
  lastOpen: false,
};

let runtimeSettings: RsbWindowSettings = { ...DEFAULTS };

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'right-sidebar-window-settings.json');
}

export function normalizeRsbWindowSettings(raw: unknown): RsbWindowSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    detached: typeof r.detached === 'boolean' ? r.detached : DEFAULTS.detached,
    lastOpen: typeof r.lastOpen === 'boolean' ? r.lastOpen : DEFAULTS.lastOpen,
  };
}

export function readRsbWindowSettings(): RsbWindowSettings {
  return { ...runtimeSettings };
}

export function writeRsbWindowSettingsPatch(patch: Partial<RsbWindowSettings>): void {
  runtimeSettings = normalizeRsbWindowSettings({ ...runtimeSettings, ...patch });
}

/** 新进程重置分离状态，并清理旧版本遗留的持久化偏好。 */
export function resetRsbWindowSettingsForStartup(): void {
  runtimeSettings = { ...DEFAULTS };
  const legacyFile = settingsFilePath();
  try {
    fs.rmSync(legacyFile, { force: true });
  } catch (err) {
    log.warn('failed to remove legacy right-sidebar window settings', { legacyFile, err });
  }
}
