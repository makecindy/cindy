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
const SOUND_STORAGE_KEY = 'notifications.soundEnabled';
const DEFAULT_ENABLED = true;
// 声音默认开(#3177):后台跑长任务时用户对完成/待回复无感是核心痛点,
// OS 通知音又可能被勿扰/专注助手吞掉,应用级提示音作为可靠兜底。
const DEFAULT_SOUND_ENABLED = true;

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

/** 应用级提示音开关的同步读路径(fireSessionNotification 的非 hook 调用方用)。 */
export function getSoundNotificationsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    if (raw === String(DEFAULT_SOUND_ENABLED)) {
      // 旧版会把当前默认值也写成 override；清掉后才能跟随未来默认值。
      localStorage.removeItem(SOUND_STORAGE_KEY);
      return DEFAULT_SOUND_ENABLED;
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // localStorage 不可用——退回默认。
  }
  return DEFAULT_SOUND_ENABLED;
}

function hasSoundNotificationOverride(): boolean {
  try {
    return localStorage.getItem(SOUND_STORAGE_KEY) === String(!DEFAULT_SOUND_ENABLED);
  } catch {
    return false;
  }
}

/** Main needs the same gate for scheduler notifications that do not originate in renderer. */
export function syncNotificationsEnabledToMain(enabled = getNotificationsEnabled()): void {
  void window.electronAPI?.notificationSetDesktopEnabled?.(enabled);
}

export function useNotificationSettings(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  soundEnabled: boolean;
  soundIsCustomized: boolean;
  setSoundEnabled: (next: boolean) => void;
  resetSoundEnabled: () => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(getNotificationsEnabled);
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(getSoundNotificationsEnabled);
  const [soundIsCustomized, setSoundIsCustomized] = useState<boolean>(hasSoundNotificationOverride);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // localStorage 不可用——忽略，UI 仍以内存值为准。
    }
    syncNotificationsEnabledToMain(next);
  }, []);

  const setSoundEnabled = useCallback((next: boolean) => {
    setSoundEnabledState(next);
    const isCustomized = next !== DEFAULT_SOUND_ENABLED;
    setSoundIsCustomized(isCustomized);
    try {
      if (isCustomized) localStorage.setItem(SOUND_STORAGE_KEY, String(next));
      else localStorage.removeItem(SOUND_STORAGE_KEY);
    } catch {
      // localStorage 不可用——忽略，UI 仍以内存值为准。
    }
  }, []);

  const resetSoundEnabled = useCallback(() => {
    setSoundEnabledState(DEFAULT_SOUND_ENABLED);
    setSoundIsCustomized(false);
    try {
      localStorage.removeItem(SOUND_STORAGE_KEY);
    } catch {
      // localStorage 不可用——UI 仍以内存默认值为准。
    }
  }, []);

  // 跨实例同步——其他实例 setEnabled 时本实例也跟着更新。
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setEnabledState(getNotificationsEnabled());
      if (e.key === SOUND_STORAGE_KEY) {
        setSoundEnabledState(getSoundNotificationsEnabled());
        setSoundIsCustomized(hasSoundNotificationOverride());
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  return {
    enabled,
    setEnabled,
    soundEnabled,
    soundIsCustomized,
    setSoundEnabled,
    resetSoundEnabled,
  };
}
