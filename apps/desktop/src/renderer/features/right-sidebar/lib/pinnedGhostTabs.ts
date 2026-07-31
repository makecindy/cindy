/**
 * pinnedGhostTabs —— 插件面板页签的「图钉」偏好(全局,跨会话)。
 *
 * 语义(三态,只持久化用户触碰过的插件,未触碰 = 无条目):
 *  - 无条目:从未打开过(或钉住关闭后回到出厂态)。打开面板页签时默认钉住
 *    (markGhostTabOpened 写入 pinned:true)。
 *  - pinned:true:钉住 —— RightSidebarShell 在每个会话自动补挂该面板页签,
 *    面板 webview 走常驻池跨会话保活。
 *  - pinned:false:用户显式取消钉住 —— 页签回到"仅当前会话"语义,后续再
 *    打开也不自动回到钉住(尊重显式 override,直到用户重新钉住)。
 *  - 关闭一个**钉住中**的页签 = 取消钉住并关闭(否则自动补挂会立刻加回来,
 *    页签"关不掉");清的是 pinned:true 条目本身(回到出厂态,下次打开重新
 *    默认钉住)。pinned:false 条目不在关闭路径清除,保留用户的显式选择。
 *
 * 存储:localStorage 单 key + 模块级单一真源(useSyncExternalStore 订阅)。
 * 页签 pill / Shell / 独立子窗口宿主都读同一份;只存 override 不存全量默认,
 * 遵循 docs/dev-rules/configuration-and-overrides.md §2(恢复默认 = 删条目)。
 *
 * 粘性焦点(lastFocusedPinnedKind)是纯运行时状态,不落盘:记录"用户正看着
 * 哪个钉住面板",切换会话时 Shell 据此把同一面板带到前台,这正是图钉的核心
 * 体验(面板视图不随会话切换消失)。
 */

import { useSyncExternalStore } from 'react';

import { createLogger } from '@/lib/logger';
import { GHOST_PANEL_KIND_PREFIX } from '../../../../shared/ghost';
import type { TabKindId } from '../types';

const log = createLogger('rightSidebar.pinnedGhostTabs');

const STORAGE_KEY = 'rightSidebar.ghostTabPins';

interface StoredPinEntry {
  pinned: boolean;
  /** ISO 8601 —— 最近一次写入时间,仅供人工排查,逻辑不消费。 */
  updatedAt: string;
}

type Stored = Record<string, StoredPinEntry>;

let cache: Stored | null = null;
let version = 0;
const listeners = new Set<() => void>();
/** 运行时粘性焦点:用户最近聚焦的钉住面板页签 kind(不持久化)。 */
let lastFocusedPinnedKind: TabKindId | null = null;

/**
 * 自动补挂页签的 state 标记。带此标记的页签是 Shell 替用户加的 —— 取消钉住后
 * 由 Shell 清扫关闭;用户**手动**打开的页签不带标记,取消钉住后按原语义留在
 * 它所在的会话里。
 */
export const AUTO_PINNED_GHOST_TAB_STATE: Readonly<{ autoPinned: true }> = { autoPinned: true };

export function isAutoPinnedGhostTabState(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { autoPinned?: unknown }).autoPinned === true
  );
}

/** `ghost:<id>` → `<id>`;不是插件面板页签 kind 返回 null。 */
export function ghostIdOfTabKind(kind: string): string | null {
  if (!kind.startsWith(GHOST_PANEL_KIND_PREFIX)) return null;
  const id = kind.slice(GHOST_PANEL_KIND_PREFIX.length);
  return id.length > 0 ? id : null;
}

function loadFromStorage(): Stored {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const entry = v as Partial<StoredPinEntry>;
      if (typeof entry.pinned !== 'boolean') continue;
      out[id] = {
        pinned: entry.pinned,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
      };
    }
    return out;
  } catch (err) {
    // JSON / localStorage 异常 → 静默回退空表(等价于全部出厂默认)。
    log.warn('failed to load stored pins:', err);
    return {};
  }
}

function writeToStorage(next: Stored): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    // quota / 隐私模式等 → 本次运行内仍生效,重启后回默认。
    log.warn('failed to write stored pins:', err);
  }
}

function getStored(): Stored {
  if (cache === null) cache = loadFromStorage();
  return cache;
}

function commit(next: Stored): void {
  cache = next;
  version += 1;
  writeToStorage(next);
  // 粘性焦点跟随钉住状态:焦点面板不再钉住时立即失效,避免会话切换时
  // Shell 把一个已取消钉住的面板强行带到前台。
  if (lastFocusedPinnedKind) {
    const gid = ghostIdOfTabKind(lastFocusedPinnedKind);
    if (!gid || next[gid]?.pinned !== true) lastFocusedPinnedKind = null;
  }
  for (const l of listeners) l();
}

/** 该插件面板当前是否钉住(无条目 = 未打开过,不算钉住)。 */
export function isGhostTabPinned(ghostId: string): boolean {
  return getStored()[ghostId]?.pinned === true;
}

/** 当前所有钉住中的插件 id。Shell 自动补挂用。 */
export function listPinnedGhostIds(): string[] {
  return Object.entries(getStored())
    .filter(([, entry]) => entry.pinned)
    .map(([id]) => id);
}

/**
 * 用户显式打开插件面板页签时调(addOrFocusSingletonTab 汇聚点):
 * 无条目 → 按默认钉住写入;已有条目(true / false 都是)→ 保持不动。
 */
export function markGhostTabOpened(ghostId: string): void {
  const stored = getStored();
  if (stored[ghostId]) return;
  commit({ ...stored, [ghostId]: { pinned: true, updatedAt: new Date().toISOString() } });
}

/** 显式钉住 / 取消钉住(pill 图钉按钮、右键菜单)。 */
export function setGhostTabPinned(ghostId: string, pinned: boolean): void {
  const stored = getStored();
  if (stored[ghostId]?.pinned === pinned) return;
  commit({ ...stored, [ghostId]: { pinned, updatedAt: new Date().toISOString() } });
}

/**
 * 关闭钉住页签的收尾:清掉 pinned:true 条目(回到出厂态)。
 * pinned:false 条目保留 —— 那是用户的显式"别钉住",关闭动作不该抹掉它。
 */
export function clearGhostTabPinOnClose(ghostId: string): void {
  const stored = getStored();
  if (stored[ghostId]?.pinned !== true) return;
  const next = { ...stored };
  delete next[ghostId];
  commit(next);
}

/** 已装清单同步点调用:插件被卸载后,遗留的钉住条目一并清除。 */
export function pruneGhostTabPins(installedIds: ReadonlySet<string>): void {
  const stored = getStored();
  let changed = false;
  const next: Stored = {};
  for (const [id, entry] of Object.entries(stored)) {
    if (installedIds.has(id)) next[id] = entry;
    else changed = true;
  }
  if (changed) commit(next);
}

/**
 * 用户显式聚焦某 tab 时调(点 pill / 新开 / 快捷键轮换)。传入被聚焦 tab 的
 * kind:是钉住中的面板页签 → 记为粘性焦点;其它任何 tab → 清空(用户已经
 * 在看别的东西,切会话不该再把面板顶回前台)。**不要**在"会话切换导致的
 * 被动 active 变化"里调 —— 那会在粘性激活生效前把它误清掉。
 */
export function setLastFocusedPinnedGhostKind(kind: TabKindId | null): void {
  if (kind !== null) {
    const gid = ghostIdOfTabKind(kind);
    if (!gid || !isGhostTabPinned(gid)) {
      lastFocusedPinnedKind = null;
      return;
    }
  }
  lastFocusedPinnedKind = kind;
}

export function getLastFocusedPinnedGhostKind(): TabKindId | null {
  return lastFocusedPinnedKind;
}

export function subscribeGhostTabPins(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getGhostTabPinsVersion(): number {
  return version;
}

/** 组件侧订阅:pin 状态变化 → 版本号变化 → 重渲染。 */
export function useGhostTabPinsVersion(): number {
  return useSyncExternalStore(subscribeGhostTabPins, getGhostTabPinsVersion);
}

/** 仅测试用:清空模块状态与持久层。 */
export function _resetGhostTabPinsForTest(): void {
  cache = {};
  version += 1;
  lastFocusedPinnedKind = null;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 测试环境无 localStorage 时忽略
  }
  for (const l of listeners) l();
}
