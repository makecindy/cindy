/**
 * useMessageNavRailPreference — 聊天区左缘"提问导航条"的显隐偏好。
 * ---------------------------------------------------------------------------
 * 两态:
 *   - true   在符合出场条件的对话里显示(系统默认值)。
 *   - false  用户可通过设置关闭导航条。
 *   - 出场仍受 MessageNavRail 的提问数量、留白与高度条件限制。
 *
 * 规则 20(配置默认值 vs override)落法:localStorage 只存 override——
 * 用户开回 true(= 当前系统默认)时**删除** key 而不是写入,这样未自定义
 * 的用户未来能自动跟随新版本默认值;isCustomized 即 "存在 override"。
 *
 * 模块级内存值做跨实例 SoT + `storage` 事件跨窗口同步,模式与
 * useLinkOpenPreference 完全一致(localStorage 写失败时切换不静默回跳)。
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'chat.messageNavRail.enabled';
const DEFAULT_ENABLED = true;
/** override 的持久化形态;只有非默认值会落盘。 */
const STORED_DISABLED = 'false';

function parseStored(raw: string | null): { value: boolean; customized: boolean } {
  if (raw === 'true') return { value: true, customized: true };
  if (raw === STORED_DISABLED) return { value: false, customized: true };
  return { value: DEFAULT_ENABLED, customized: false };
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
    return { value: DEFAULT_ENABLED, customized: false };
  }
}

/** 同步读——给非 hook 路径用。 */
export function getMessageNavRailEnabled(): boolean {
  return readPreference().value;
}

const listeners = new Set<() => void>();

export function useMessageNavRailPreference(): {
  enabled: boolean;
  /** 是否存在用户 override(≠ 系统默认)。设置页据此显示「恢复默认」。 */
  isCustomized: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [preference, setPreference] = useState(readPreference);

  const setEnabled = useCallback((next: boolean) => {
    memoryValue = next;
    memoryCustomized = next !== DEFAULT_ENABLED;
    setPreference({ value: next, customized: memoryCustomized });
    try {
      if (next === DEFAULT_ENABLED) {
        // 开回默认 = 清除 override(而非写入默认值快照)。
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, STORED_DISABLED);
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
    enabled: preference.value,
    isCustomized: preference.customized,
    setEnabled,
  };
}

/** 测试专用:清空内存 SoT,让下一次读回落 localStorage / 默认值。 */
export function _resetMessageNavRailPreferenceForTests(): void {
  memoryValue = null;
  memoryCustomized = null;
  listeners.clear();
}
