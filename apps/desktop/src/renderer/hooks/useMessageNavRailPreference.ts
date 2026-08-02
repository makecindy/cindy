/**
 * useMessageNavRailPreference — 聊天区左缘"提问导航条"的显隐偏好。
 * ---------------------------------------------------------------------------
 * 两态:
 *   - false  不显示导航条(系统默认值)。
 *   - true   在符合出场条件的对话里显示(提问 ≥4、留白/高度达标,见 MessageNavRail)。
 *
 * 规则 20(配置默认值 vs override)落法:localStorage 只存 override——
 * 用户关回 false(= 当前系统默认)时**删除** key 而不是写入,这样未自定义
 * 的用户未来能自动跟随新版本默认值;isCustomized 即 "存在 override"。
 *
 * 模块级内存值做跨实例 SoT + `storage` 事件跨窗口同步,模式与
 * useLinkOpenPreference 完全一致(localStorage 写失败时切换不静默回跳)。
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'chat.messageNavRail.enabled';
const DEFAULT_ENABLED = false;
/** override 的持久化形态;只有非默认值会落盘。 */
const STORED_ENABLED = 'true';

function parseStored(raw: string | null): boolean | null {
  return raw === STORED_ENABLED ? true : null;
}

/** 模块级内存 SoT;null = 尚未被本窗口读定/写定。 */
let memoryValue: boolean | null = null;

/** 同步读——给非 hook 路径用。 */
export function getMessageNavRailEnabled(): boolean {
  if (memoryValue !== null) return memoryValue;
  try {
    const parsed = parseStored(localStorage.getItem(STORAGE_KEY));
    if (parsed !== null) return (memoryValue = parsed);
  } catch {
    // localStorage 不可用——退回默认(不落定内存,留待后续写入)。
  }
  return DEFAULT_ENABLED;
}

const listeners = new Set<() => void>();

export function useMessageNavRailPreference(): {
  enabled: boolean;
  /** 是否存在用户 override(≠ 系统默认)。设置页据此显示「恢复默认」。 */
  isCustomized: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setState] = useState<boolean>(getMessageNavRailEnabled);

  const setEnabled = useCallback((next: boolean) => {
    memoryValue = next;
    setState(next);
    try {
      if (next === DEFAULT_ENABLED) {
        // 关回默认 = 清除 override(而非写入默认值快照)。
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
    const sync = () => setState(getMessageNavRailEnabled());
    listeners.add(sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      memoryValue = parseStored(e.newValue) ?? DEFAULT_ENABLED;
      sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { enabled, isCustomized: enabled !== DEFAULT_ENABLED, setEnabled };
}

/** 测试专用:清空内存 SoT,让下一次读回落 localStorage / 默认值。 */
export function _resetMessageNavRailPreferenceForTests(): void {
  memoryValue = null;
  listeners.clear();
}
