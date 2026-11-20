/**
 * useWorktreeModelNamingPreference — 新任务的 worktree 是否用模型取名。
 * ---------------------------------------------------------------------------
 *   - false  沿用随机名（如 `brave-turing`），系统默认值。
 *   - true   发送第一条消息时让辅助模型按任务内容取一个英文短名（如
 *            `fix-login-timeout`），失败或超时仍用随机名。只影响之后新建的 worktree。
 *
 * localStorage 只存 override：关回默认时删除 key，未自定义的用户跟随版本默认；
 * isCustomized 即「存在 override」。模块级内存值做同步读与跨实例真值，
 * `storage` 事件做跨窗口同步，模式与 useMessageNavRailPreference 一致。
 */

import { useCallback, useEffect, useState } from 'react';

export const WORKTREE_MODEL_NAMING_STORAGE_KEY = 'worktree.modelNaming.enabled';
const DEFAULT_ENABLED = false;
/** override 的持久化形态；只有非默认值会落盘。 */
const STORED_ENABLED = 'true';

function parseStored(raw: string | null): { value: boolean; customized: boolean } {
  if (raw === STORED_ENABLED) return { value: true, customized: true };
  if (raw === 'false') return { value: false, customized: true };
  return { value: DEFAULT_ENABLED, customized: false };
}

/** 模块级内存真值；null = 尚未被本窗口读定/写定。 */
let memoryValue: boolean | null = null;
let memoryCustomized: boolean | null = null;

function readPreference(): { value: boolean; customized: boolean } {
  if (memoryValue !== null && memoryCustomized !== null) {
    return { value: memoryValue, customized: memoryCustomized };
  }
  try {
    const parsed = parseStored(localStorage.getItem(WORKTREE_MODEL_NAMING_STORAGE_KEY));
    memoryValue = parsed.value;
    memoryCustomized = parsed.customized;
    return parsed;
  } catch {
    return { value: DEFAULT_ENABLED, customized: false };
  }
}

/** 同步读——给发送流程等非 hook 路径用。 */
export function getWorktreeModelNamingEnabled(): boolean {
  return readPreference().value;
}

const listeners = new Set<() => void>();

export function useWorktreeModelNamingPreference(): {
  enabled: boolean;
  /** 是否存在用户 override（≠ 系统默认）。设置页据此显示「恢复默认」。 */
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
        // 关回默认 = 清除 override（而非写入默认值快照）。
        localStorage.removeItem(WORKTREE_MODEL_NAMING_STORAGE_KEY);
      } else {
        localStorage.setItem(WORKTREE_MODEL_NAMING_STORAGE_KEY, STORED_ENABLED);
      }
    } catch {
      // localStorage 不可用——内存真值已生效；仅跨窗口同步缺失。
    }
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const sync = () => setPreference(readPreference());
    listeners.add(sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== WORKTREE_MODEL_NAMING_STORAGE_KEY) return;
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
