/**
 * useLocalPathDropConfirmPreference — 路径型文件拖拽是否先确认。
 *
 * 默认关闭：从 VS Code 拖入文件时直接进入附件托盘。开启后，任何只带
 * text/plain / text/uri-list / ResourceURLs 等路径数据的拖拽都会先弹确认，
 * 避免网页伪造路径把未选择的本地文件加入附件。
 *
 * 与 useMessageNavRailPreference 相同，localStorage 只保存非默认 override：
 * 关闭设置时删除 key，让未自定义用户继续跟随未来默认值。
 */

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'composer.localPathDropConfirm.enabled';
const DEFAULT_ENABLED = false;
const STORED_ENABLED = 'true';

function parseStored(raw: string | null): { value: boolean; customized: boolean } {
  if (raw === 'true') return { value: true, customized: true };
  if (raw === 'false') return { value: false, customized: true };
  return { value: DEFAULT_ENABLED, customized: false };
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
  return readPreference().value;
}

const listeners = new Set<() => void>();

export function setLocalPathDropConfirmEnabled(next: boolean): void {
  memoryValue = next;
  memoryCustomized = next !== DEFAULT_ENABLED;
  try {
    if (next === DEFAULT_ENABLED) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, STORED_ENABLED);
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
