/**
 * ghost-panel-window 进程内状态。
 *
 * 每个 ghostId 的 detached / lastOpen 只服务当前客户端进程，用于窗口状态机和隐藏复用；
 * 客户端重启后所有插件面板一律回到主窗口。启动时还会删除旧版本留下的分离偏好文件。
 * 窗口尺寸与位置由独立的 window-state 文件管理，不受这里影响。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { isValidGhostId } from '../../shared/ghost.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';

const log = desktopMakerLogger.child('ghost-panel-window-settings-store');

export interface GhostPanelWindowEntrySettings {
  detached: boolean;
  lastOpen: boolean;
}

export interface GhostPanelWindowsSettings {
  windows: Record<string, GhostPanelWindowEntrySettings>;
}

let runtimeSettings: GhostPanelWindowsSettings = { windows: {} };

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'ghost-panel-windows-settings.json');
}

/** 逐条清洗:非法 ghostId / 非布尔字段整条丢弃(fail closed,坏数据不进状态机)。 */
export function normalizeGhostPanelWindowsSettings(raw: unknown): GhostPanelWindowsSettings {
  if (!raw || typeof raw !== 'object') return { windows: {} };
  const rawWindows = (raw as Record<string, unknown>).windows;
  if (!rawWindows || typeof rawWindows !== 'object') return { windows: {} };
  const windows: Record<string, GhostPanelWindowEntrySettings> = {};
  for (const [id, entry] of Object.entries(rawWindows as Record<string, unknown>)) {
    if (!isValidGhostId(id)) continue;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.detached !== 'boolean' || typeof e.lastOpen !== 'boolean') continue;
    windows[id] = { detached: e.detached, lastOpen: e.lastOpen };
  }
  return { windows };
}

export function readGhostPanelWindowsSettings(): GhostPanelWindowsSettings {
  return { windows: { ...runtimeSettings.windows } };
}

/** 单条 patch:writePatch 是浅合并,windows map 必须整体读改写。 */
export function patchGhostPanelWindowEntry(
  ghostId: string,
  patch: Partial<GhostPanelWindowEntrySettings>,
): void {
  const current = runtimeSettings.windows;
  const entry = current[ghostId] ?? { detached: false, lastOpen: false };
  runtimeSettings = { windows: { ...current, [ghostId]: { ...entry, ...patch } } };
}

/** 删条目(卸载清理):不存在时为 no-op。 */
export function removeGhostPanelWindowEntry(ghostId: string): void {
  const current = runtimeSettings.windows;
  if (!(ghostId in current)) return;
  const next = { ...current };
  delete next[ghostId];
  runtimeSettings = { windows: next };
}

/** 新进程重置全部插件面板的分离状态，并清理旧版本遗留的持久化偏好。 */
export function resetGhostPanelWindowSettingsForStartup(): void {
  runtimeSettings = { windows: {} };
  const legacyFile = settingsFilePath();
  try {
    fs.rmSync(legacyFile, { force: true });
  } catch (err) {
    log.warn('failed to remove legacy ghost-panel window settings', { legacyFile, err });
  }
}
