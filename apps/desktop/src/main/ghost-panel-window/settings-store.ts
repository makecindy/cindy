/**
 * ghost-panel-window settings-store —— 「插件面板在独立窗口中显示」的持久化。
 *
 * File: <userData>/ghost-panel-windows-settings.json
 *
 * 形如 { windows: { <ghostId>: { detached, lastOpen } } }。语义对照
 * right-sidebar-window/settings-store.ts(同一 override 模型、同只由 main 的
 * controller 写),差异是按 ghostId 多条:每个插件面板各自记偏好与恢复状态。
 *  - detached: **偏好**。用户点了该面板的「独立窗口」按钮;
 *  - lastOpen: **状态**。退出时该窗口是否开着,供下次启动恢复。
 * 没有条目 = 从未抽离(等价两个 false)。
 */

import { app } from 'electron';
import path from 'node:path';

import { isValidGhostId } from '../../shared/ghost.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('ghost-panel-window-settings-store');

export interface GhostPanelWindowEntrySettings {
  detached: boolean;
  lastOpen: boolean;
}

export interface GhostPanelWindowsSettings {
  windows: Record<string, GhostPanelWindowEntrySettings>;
}

const DEFAULTS: GhostPanelWindowsSettings = { windows: {} };

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

const store = createOverrideSettingsFile<GhostPanelWindowsSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize: normalizeGhostPanelWindowsSettings,
  log,
  label: 'ghost-panel-windows',
});

export function readGhostPanelWindowsSettings(): GhostPanelWindowsSettings {
  return store.read();
}

/** 单条 patch:writePatch 是浅合并,windows map 必须整体读改写。 */
export function patchGhostPanelWindowEntry(
  ghostId: string,
  patch: Partial<GhostPanelWindowEntrySettings>,
): void {
  const current = store.read().windows;
  const entry = current[ghostId] ?? { detached: false, lastOpen: false };
  store.writePatch({ windows: { ...current, [ghostId]: { ...entry, ...patch } } });
}

/** 删条目(卸载清理):不存在时为 no-op。 */
export function removeGhostPanelWindowEntry(ghostId: string): void {
  const current = store.read().windows;
  if (!(ghostId in current)) return;
  const next = { ...current };
  delete next[ghostId];
  store.writePatch({ windows: next });
}
