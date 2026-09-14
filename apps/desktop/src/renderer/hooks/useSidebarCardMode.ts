/**
 * useSidebarCardMode — 侧边栏显示模式(置顶段 / 主列表分离,sidebar-redesign B 期)。
 * ---------------------------------------------------------------------------
 * 两份独立设置(docs/product-rules/sidebar-redesign-plan.md §3.4 / §4):
 *   - 置顶段:'text' | 'card' | 'list' 三态(卡片版仅置顶支持)。
 *   - 主列表:'text' | 'list' 两态,默认 'list'(定稿默认值)。
 *
 * localStorage keys:
 *   - 置顶段沿用 `sidebar.cardMode`(向后兼容):读取时兼容旧 boolean 字符串
 *     ('true'→'card','false'→'text')。
 *   - 主列表新增 `sidebar.mainListMode`。首次读取(无值)时从置顶段旧值粗略迁移:
 *     text→text,card/list→list(主列表无 card 档;定稿:迁移不追求完美)。
 *     两处都没有痕迹时按安装新旧给默认:新安装 'list',**老安装 'text'**——
 *     老用户升级后侧栏观感不变(2026-08-12 用户裁决,见 sidebarInstallVintage)。
 *
 * 模块级内存值做跨实例 SoT;`storage` 事件做跨窗口同步(同 useNotificationSettings 模式)。
 */

import { useCallback, useEffect, useState } from 'react';

import { getSidebarInstallVintage } from '@/features/cc-agent/lib/sidebarInstallVintage';

export type SidebarViewMode = 'text' | 'card' | 'list';
/** 主列表显示模式:无 card 档(卡片版仅置顶区支持)。 */
export type SidebarMainViewMode = 'text' | 'list';

const STORAGE_KEY = 'sidebar.cardMode';
const MAIN_STORAGE_KEY = 'sidebar.mainListMode';
const DEFAULT_MODE: SidebarViewMode = 'text';
const DEFAULT_MAIN_MODE: SidebarMainViewMode = 'list';

/** 解析存储值;兼容旧 boolean 字符串。无法识别返回 null(由调用方落默认)。 */
function parseMode(raw: string | null): SidebarViewMode | null {
  if (raw === 'text' || raw === 'card' || raw === 'list') return raw;
  if (raw === 'true') return 'card'; // 旧版 cardMode=true
  if (raw === 'false') return 'text'; // 旧版 cardMode=false
  return null;
}

function parseMainMode(raw: string | null): SidebarMainViewMode | null {
  if (raw === 'text' || raw === 'list') return raw;
  return null;
}

/**
 * 模块级内存值 = 跨实例 SoT。一旦被 setMode 或 storage 事件写定,getSidebarViewMode
 * 即返回它、不再回读 localStorage——localStorage 写失败时 listener 回读也拿内存新值,
 * 不会把刚切换的窗口又改回旧值(切换静默失效 bug)。初始 null:首个读取者落定一次。
 */
let memoryValue: SidebarViewMode | null = null;
let mainMemoryValue: SidebarMainViewMode | null = null;

/** 同步读(置顶段)——给非 hook 路径用。 */
export function getSidebarViewMode(): SidebarViewMode {
  if (memoryValue !== null) return memoryValue;
  try {
    const parsed = parseMode(localStorage.getItem(STORAGE_KEY));
    if (parsed) return (memoryValue = parsed);
  } catch {
    // localStorage 不可用——退回默认(不落定内存,留待后续写入)。
  }
  return DEFAULT_MODE;
}

/**
 * 同步读(主列表)。优先级:显式设置 > 从置顶段旧值迁移 > 按安装新旧给默认。
 *
 * 最后一档是兼容性要求(2026-08-12 用户裁决):新用户默认列表视图,**老用户升级
 * 后保持文字视图**——包括从没动过显示模式、localStorage 里没有 cardMode 的那批人
 * (他们靠 sidebarInstallVintage 的使用痕迹识别)。
 */
export function getSidebarMainViewMode(): SidebarMainViewMode {
  if (mainMemoryValue !== null) return mainMemoryValue;
  try {
    const parsed = parseMainMode(localStorage.getItem(MAIN_STORAGE_KEY));
    if (parsed) return (mainMemoryValue = parsed);
    // 一次性迁移:老用户只有整侧栏一份 cardMode。text 保持紧凑;card/list 都映射
    // 到主列表 list(宽行)。不回写 storage——迁移是纯读取推导,用户首次显式切换才落盘。
    const legacy = parseMode(localStorage.getItem(STORAGE_KEY));
    if (legacy) return (mainMemoryValue = legacy === 'text' ? 'text' : 'list');
    // 没有任何显示模式痕迹:老安装沿用旧版观感(文字版),新安装用新默认(列表)。
    if (getSidebarInstallVintage() === 'legacy') return (mainMemoryValue = 'text');
  } catch {
    // localStorage 不可用——退回默认(不落定内存,留待后续写入)。
  }
  return DEFAULT_MAIN_MODE;
}

function notifyPinnedCardSummaries(mode: SidebarViewMode): void {
  try {
    const setEnabled = window.electronAPI?.localDb?.sessions?.setPinnedCardSummaries;
    if (typeof setEnabled !== 'function') return;
    void setEnabled(mode === 'card');
  } catch {
    // tests / preload 未挂载
  }
}

/** 同标签页内的实例间同步(原生 storage 事件只发给其它窗口)。 */
const listeners = new Set<() => void>();

/** main 的卡片模式投影只由 setMode / storage 事件 / 本 renderer 首次挂载写入。
 *  重挂载不得再通知:否则会把失败的 setItem 留下的旧持久值盖回 main。 */
let mainNotified = false;
let storageListenerBound = false;

export function shouldNotifyMainOnPinnedModeMount(mainAlreadyNotified: boolean): boolean {
  return !mainAlreadyNotified;
}

function applyPinnedModeFromStorage(raw: string | null): void {
  memoryValue = parseMode(raw) ?? DEFAULT_MODE;
  mainNotified = true;
  notifyPinnedCardSummaries(memoryValue);
  listeners.forEach((fn) => fn());
}

function ensurePinnedModeStorageListener(): void {
  if (storageListenerBound || typeof window === 'undefined') return;
  storageListenerBound = true;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    applyPinnedModeFromStorage(e.newValue);
  });
}

export function useSidebarCardMode(): {
  mode: SidebarViewMode;
  setMode: (next: SidebarViewMode) => void;
} {
  const [mode, setModeState] = useState<SidebarViewMode>(getSidebarViewMode);

  const setMode = useCallback((next: SidebarViewMode) => {
    // 先写内存 SoT,再 setState + 通知 listener——即便下面 setItem 抛错,本窗口也不会
    // 被 listener 回读旧 storage 改回去(切换静默失效 bug)。
    memoryValue = next;
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage 不可用——内存 SoT 已生效;仅跨窗口同步缺失。
    }
    mainNotified = true;
    notifyPinnedCardSummaries(next);
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    ensurePinnedModeStorageListener();
    if (shouldNotifyMainOnPinnedModeMount(mainNotified)) {
      mainNotified = true;
      notifyPinnedCardSummaries(getSidebarViewMode());
    }
    const sync = () => setModeState(getSidebarViewMode());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  return { mode, setMode };
}

/** 主列表显示模式 hook——与置顶段同构,独立 key 与 listener 集合。 */
const mainListeners = new Set<() => void>();

export function useSidebarMainViewMode(): {
  mode: SidebarMainViewMode;
  setMode: (next: SidebarMainViewMode) => void;
} {
  const [mode, setModeState] = useState<SidebarMainViewMode>(getSidebarMainViewMode);

  const setMode = useCallback((next: SidebarMainViewMode) => {
    mainMemoryValue = next;
    setModeState(next);
    try {
      localStorage.setItem(MAIN_STORAGE_KEY, next);
    } catch {
      // localStorage 不可用——内存 SoT 已生效;仅跨窗口同步缺失。
    }
    mainListeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const sync = () => setModeState(getSidebarMainViewMode());
    mainListeners.add(sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== MAIN_STORAGE_KEY) return;
      mainMemoryValue = parseMainMode(e.newValue) ?? DEFAULT_MAIN_MODE;
      sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      mainListeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { mode, setMode };
}
