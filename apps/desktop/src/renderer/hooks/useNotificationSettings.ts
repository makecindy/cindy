/**
 * useNotificationSettings — 系统级桌面通知的全局开关。
 * ---------------------------------------------------------------------------
 * 仿 useTheme 的 localStorage 模式：
 *   - 单一开关 `enabled`，默认 true。
 *   - 用 `notifications.enabled` 这个 key 写 localStorage。
 *   - 监听 `storage` 事件做跨组件实例同步——任何调用方 setEnabled，所有
 *     mount 的实例下一帧都会反映新值（实际只有一个窗口，但保留这层保险）。
 *
 * 没有用 Context Provider——开关只是一个 boolean，单例语义靠 storage 即可，
 * 不必引入额外 Provider 层。
 *
 * 同步读取（非 hook 路径）由 `getNotificationsEnabled()` 提供，给 hook 之外
 * 的逻辑用（例如 transition 检测里临时拿值，避免 stale closure）。
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'notifications.enabled';
const DEFAULT_ENABLED = true;
const CHANGE_EVENT = 'notifications-enabled-changed';

/** 同步读 localStorage——主要给非 hook 路径用。坏数据当默认值。 */
export function getNotificationsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // localStorage 不可用——退回默认。
  }
  return DEFAULT_ENABLED;
}

/** Main needs the same gate for scheduler notifications that do not originate in renderer. */
export function syncNotificationsEnabledToMain(enabled = getNotificationsEnabled()): void {
  void window.electronAPI?.notificationSetDesktopEnabled?.(enabled);
}

export function useNotificationSettings(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(getNotificationsEnabled);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // localStorage 不可用——忽略，UI 仍以内存值为准。
    }
    syncNotificationsEnabledToMain(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  // 跨实例同步——其他实例 setEnabled 时本实例也跟着更新。
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setEnabledState(getNotificationsEnabled());
    };
    const sync = () => setEnabledState(getNotificationsEnabled());
    window.addEventListener('storage', handler);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => { window.removeEventListener('storage', handler); window.removeEventListener(CHANGE_EVENT, sync); };
  }, []);

  return { enabled, setEnabled };
}
