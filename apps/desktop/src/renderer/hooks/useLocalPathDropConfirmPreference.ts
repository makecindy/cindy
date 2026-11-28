/**
 * useLocalPathDropConfirmPreference — 路径型文件拖拽是否先确认。
 *
 * 默认开启：只带 text/plain / text/uri-list / ResourceURLs 等路径数据的拖拽
 * 无法证明用户选中过那个文件（普通网页也能写这些格式），所以默认先弹确认，
 * 避免伪造路径把用户没选择的本地文件读进附件链路。带 File 对象的系统文件
 * 拖拽、内部 mention 拖拽和 MCP App 拖拽不经过这里。
 *
 * 用户在设置 → 个性化里关掉，或在确认弹窗里取消勾选，都能永久免询问；
 * 弹窗默认勾选「拖入本地文件时先询问」，也就是每次路径拖拽都会问一次。
 *
 * 与 useMessageNavRailPreference 相同，localStorage 只保存非默认 override：
 * 恢复默认时删除 key，让未自定义用户继续跟随未来默认值。
 */

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'composer.localPathDropConfirm.enabled';
const DEFAULT_ENABLED = true;

function parseStored(raw: string | null): { value: boolean; customized: boolean } {
  if (raw !== 'true' && raw !== 'false') return { value: DEFAULT_ENABLED, customized: false };
  const value = raw === 'true';
  // 与默认值相同的存量 override 不算自定义：开关本来就在这个位置。
  return { value, customized: value !== DEFAULT_ENABLED };
}

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
    return { value: DEFAULT_ENABLED, customized: false };
  }
}

/** 同步读取，供拖拽处理链路在进入 React 渲染前判断。 */
export function getLocalPathDropConfirmEnabled(): boolean {
  // Read storage on every drag: the setting can be changed in another window
  // while this window has no mounted settings row listening for storage events.
  try {
    return parseStored(localStorage.getItem(STORAGE_KEY)).value;
  } catch {
    return DEFAULT_ENABLED;
  }
}

const listeners = new Set<() => void>();

export function setLocalPathDropConfirmEnabled(next: boolean): void {
  memoryValue = next;
  memoryCustomized = next !== DEFAULT_ENABLED;
  try {
    // 只存与默认值不同的 override：默认值(开启)不落 key。
    if (next === DEFAULT_ENABLED) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // localStorage 不可用时保留本次内存状态。
  }
  listeners.forEach((fn) => fn());
}

export function useLocalPathDropConfirmPreference(): {
  enabled: boolean;
  isCustomized: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [preference, setPreference] = useState(readPreference);

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
    enabled: preference.value,
    isCustomized: preference.customized,
    setEnabled: setLocalPathDropConfirmEnabled,
  };
}

/** 测试专用：清空内存 SoT。 */
export function _resetLocalPathDropConfirmPreferenceForTests(): void {
  memoryValue = null;
  memoryCustomized = null;
  listeners.clear();
}
