/**
 * useFileBrowserPreference — 侧边栏文件浏览器的视图偏好。
 * ---------------------------------------------------------------------------
 * 当前只有一个开关:
 *   - showIgnoredDirs  文件树是否列出 Cindy 默认隐藏的目录(依赖 / 构建产物 /
 *                      缓存:,如 build / dist / out / node_modules / Library)。
 *                      默认 false = 保持历史行为。
 *
 * 规则 20(配置默认值 vs override):localStorage 只存 override——用户改回
 * 默认值时**删除** key 而不是写入,这样未自定义的用户未来能跟随新版本默认值;
 * isCustomized 即「存在 override」。
 *
 * 模块级内存 SoT + `storage` 事件跨窗口同步(同 useLinkOpenPreference /
 * useMessageNavRailPreference)。文件浏览器在 RSB 分离窗口里会单独挂载,而
 * 两个窗口共享同一份 localStorage,storage 事件把改动同步过去。
 *
 * 消费方:`WorkdirBrowseSidebar`(doc 模式侧栏)与 RSB 的 `FileBrowserBody`
 * 都把它喂给 `useFileTree`,store 的 key 包含该开关 → 切换开关会换 store,
 * 连带 listDir 与 watcher 用新的 matcher 重建。
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'fileBrowser.showIgnoredDirs';
/** 系统默认:隐藏(与 BUILTIN_IGNORE 的历史行为一致,Unity Library 之类目录太大)。 */
const DEFAULT_SHOW_IGNORED_DIRS = false;
/** override 的持久化形态;只有非默认值会落盘。 */
const STORED_ENABLED = 'true';

function parseStored(raw: string | null): { value: boolean; customized: boolean } {
  if (raw === STORED_ENABLED) return { value: true, customized: true };
  if (raw === 'false') return { value: false, customized: true };
  return { value: DEFAULT_SHOW_IGNORED_DIRS, customized: false };
}

/** 模块级内存 SoT;null = 尚未被本窗口读定/写定。 */
let memoryValue: boolean | null = null;
let memoryCustomized: boolean | null = null;

function readPreference(): { value: boolean; customized: boolean } {
  if (memoryValue !== null && memoryCustomized !== null) {
    return { value: memoryValue, customized: memoryCustomized };
  }
  try {
    const parsed = parseStored(localStorage.getItem(STORAGE_KEY));
    memoryValue = parsed.value;
    memoryCustomized = parsed.customized;
    return parsed;
  } catch {
    // localStorage 不可用——退回默认(不落定内存,留待后续写入)。
    return { value: DEFAULT_SHOW_IGNORED_DIRS, customized: false };
  }
}

/** 同步读——给非 hook 路径用。 */
export function getShowIgnoredDirs(): boolean {
  return readPreference().value;
}

const listeners = new Set<() => void>();

export function useFileBrowserPreference(): {
  showIgnoredDirs: boolean;
  /** 是否存在用户 override(≠ 系统默认)。设置页据此显示「恢复默认」。 */
  isCustomized: boolean;
  setShowIgnoredDirs: (next: boolean) => void;
} {
  const [preference, setPreference] = useState(readPreference);

  const setShowIgnoredDirs = useCallback((next: boolean) => {
    memoryValue = next;
    memoryCustomized = next !== DEFAULT_SHOW_IGNORED_DIRS;
    setPreference({ value: next, customized: memoryCustomized });
    try {
      if (next === DEFAULT_SHOW_IGNORED_DIRS) {
        // 改回默认 = 清除 override(而非写入默认值快照)。
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, STORED_ENABLED);
      }
    } catch {
      // localStorage 不可用——内存 SoT 已生效;仅跨窗口同步缺失。
    }
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const sync = () => setPreference(readPreference());
    listeners.add(sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = parseStored(e.newValue);
      memoryValue = next.value;
      memoryCustomized = next.customized;
      sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return {
    showIgnoredDirs: preference.value,
    isCustomized: preference.customized,
    setShowIgnoredDirs,
  };
}

/** 测试专用:清空内存 SoT,让下一次读回落 localStorage / 默认值。 */
export function _resetFileBrowserPreferenceForTests(): void {
  memoryValue = null;
  memoryCustomized = null;
  listeners.clear();
}
