/**
 * ghostWorkdirPrefs —— 意识的「工作目录级禁用」偏好持久化。
 *
 * File: <userData>/ghost-workdir-prefs.json
 *
 * 形态:{ disabledByWorkdir: { <归一化目录键>: [ghostId, …] } }
 * - 语义:某意识被记在某目录键下 = 该目录的会话里不可使用——花名册
 *   不出现、ghost_list 不返回、ghost_info 返回目录禁用错误、`$` 指令
 *   不点亮,ghost_call 调用时刻兜底拒绝(老会话快照已含自述的防御线)。
 * - 全局唤醒/沉睡(GhostManager.enabled)仍是主开关;本文件只记
 *   "全局唤醒之上的目录级例外",一个方向:禁用。没写 = 跟随全局
 *   (规则 20:override 与默认分开记,清除 override 即回到跟随)。
 * - 抽离意识**不**清目录例外——与 cindyPrefsStore"重装回来配置还在"
 *   同语义;normalize 不感知已装清单,幽灵条目无害(匹配不到任何意识)。
 * - 读取入口带 invalidateIfChanged():用户/agent 直接改文件即生效
 *   (支持"跟 Cindy 说一句就改配置"的自然语言路径)。
 *
 * 目录键归一化(纯字符串,**禁止 fs.realpath**——远程 SSH 工作区的
 * workdir 是远端路径,本机 fs 解析必错;规则 26):
 * - Windows 形态(盘符开头或含反斜杠):分隔符统一为 `\`、去尾分隔符、
 *   小写折叠(NTFS 大小写不敏感);
 * - POSIX 形态:仅去尾部 `/`,保留大小写(远端 Linux 区分大小写)。
 */

import path from 'node:path';

import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('ghost-workdir-prefs');

export interface GhostWorkdirPrefs {
  /** 归一化目录键 → 该目录下被禁用的 ghostId 列表(去重、排序稳定)。 */
  disabledByWorkdir: Record<string, string[]>;
}

const DEFAULTS: GhostWorkdirPrefs = { disabledByWorkdir: {} };

/** 目录键归一化(导出供测试;两端形态判定见文件头注释)。 */
export function normalizeWorkdirKey(dir: string): string {
  const trimmed = dir.trim();
  if (trimmed.length === 0) return '';
  const looksWindows = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes('\\');
  if (looksWindows) {
    // win32.normalize 统一分隔符并折叠 '..';根目录(C:\)保留尾分隔符。
    let n = path.win32.normalize(trimmed);
    if (n.length > 3 && (n.endsWith('\\') || n.endsWith('/'))) n = n.slice(0, -1);
    return n.toLowerCase();
  }
  let n = path.posix.normalize(trimmed);
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

function normalize(raw: unknown): GhostWorkdirPrefs {
  if (!raw || typeof raw !== 'object') return { disabledByWorkdir: {} };
  const mapRaw = (raw as { disabledByWorkdir?: unknown }).disabledByWorkdir;
  const disabledByWorkdir: Record<string, string[]> = {};
  if (mapRaw && typeof mapRaw === 'object' && !Array.isArray(mapRaw)) {
    for (const [dirKey, idsRaw] of Object.entries(mapRaw as Record<string, unknown>)) {
      if (!Array.isArray(idsRaw)) continue;
      const key = normalizeWorkdirKey(dirKey);
      if (key.length === 0) continue;
      const ids = [...new Set(idsRaw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))].sort();
      if (ids.length === 0) continue;
      // 同一目录两种写法归一后撞键 → 并集(手改文件的容错)。
      const merged = disabledByWorkdir[key] ? [...new Set([...disabledByWorkdir[key], ...ids])].sort() : ids;
      disabledByWorkdir[key] = merged;
    }
  }
  return { disabledByWorkdir };
}

const store = createOverrideSettingsFile<GhostWorkdirPrefs>({
  filePath: () => ownerScopedUserDataPath('ghost-workdir-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'ghost-workdir-prefs',
});

function readPrefs(): GhostWorkdirPrefs {
  store.invalidateIfChanged();
  return store.read();
}

/** 该目录下被禁用的 ghostId 列表;workdir 空/缺省(无会话语境)= 无例外。 */
export function listDisabledGhostIdsForWorkdir(workdir: string | null | undefined): string[] {
  if (!workdir || workdir.trim().length === 0) return [];
  return readPrefs().disabledByWorkdir[normalizeWorkdirKey(workdir)] ?? [];
}

/** 某意识在某目录是否被禁用(生效点统一走这一个谓词)。 */
export function isGhostDisabledForWorkdir(ghostId: string, workdir: string | null | undefined): boolean {
  return listDisabledGhostIdsForWorkdir(workdir).includes(ghostId);
}

/** 写入目录级例外;返回该目录写后的禁用列表(供 IPC 回包)。 */
export function setGhostDisabledForWorkdir(workdir: string, ghostId: string, disabled: boolean): string[] {
  const key = normalizeWorkdirKey(workdir);
  if (key.length === 0) throw new Error('workdir must be a non-empty path');
  const current = readPrefs().disabledByWorkdir;
  const ids = new Set(current[key] ?? []);
  if (disabled) ids.add(ghostId);
  else ids.delete(ghostId);
  const next = { ...current };
  if (ids.size === 0) delete next[key];
  else next[key] = [...ids].sort();
  store.writePatch({ disabledByWorkdir: next });
  log.info('ghost workdir pref updated', { workdirKey: key, ghostId, disabled });
  return next[key] ?? [];
}

/** 测试钩子(仅纯函数;读写链路由 IPC / 生效点测试覆盖)。 */
export const __testing = { normalize, normalizeWorkdirKey };
