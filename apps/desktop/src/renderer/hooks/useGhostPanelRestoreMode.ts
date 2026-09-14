/**
 * useGhostPanelRestoreMode —— 最小化插件面板的恢复入口偏好。
 *
 * 两种入口严格互斥:
 * - bubble:主窗口浮动幽灵球(历史默认);
 * - sidebar:左侧栏“恢复插件面板”入口。
 *
 * 默认值只存在于代码中,localStorage 仅保存 sidebar override。这样老用户升级后
 * 继续看到原有幽灵球,未来调整默认值时也不会被无意义的默认快照卡住。
 */

import { useCallback, useEffect, useState } from 'react';

export type GhostPanelRestoreMode = 'bubble' | 'sidebar';

const STORAGE_KEY = 'ghostPanel.restoreMode';
const DEFAULT_MODE: GhostPanelRestoreMode = 'bubble';

let memoryValue: GhostPanelRestoreMode | null = null;
const listeners = new Set<() => void>();
let storageSubscribed = false;

function parseMode(raw: string | null): GhostPanelRestoreMode | null {
  return raw === 'bubble' || raw === 'sidebar' ? raw : null;
}

function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  memoryValue = parseMode(event.newValue) ?? DEFAULT_MODE;
  notifyListeners();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageSubscribed) {
    window.addEventListener('storage', onStorage);
    storageSubscribed = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageSubscribed) {
      window.removeEventListener('storage', onStorage);
      storageSubscribed = false;
    }
  };
}

export function getGhostPanelRestoreMode(): GhostPanelRestoreMode {
  if (memoryValue !== null) return memoryValue;
  try {
    const parsed = parseMode(window.localStorage.getItem(STORAGE_KEY));
    if (parsed === DEFAULT_MODE) {
      window.localStorage.removeItem(STORAGE_KEY);
      return (memoryValue = DEFAULT_MODE);
    }
    if (parsed) return (memoryValue = parsed);
  } catch {
    // localStorage 不可用时保留代码默认值,后续显式设置仍可在内存中即时生效。
  }
  return DEFAULT_MODE;
}

export function setGhostPanelRestoreMode(next: GhostPanelRestoreMode): void {
  memoryValue = next;
  try {
    if (next === DEFAULT_MODE) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 持久化失败不拦当前窗口交互。
  }
  notifyListeners();
}

export function useGhostPanelRestoreMode(): {
  mode: GhostPanelRestoreMode;
  setMode: (next: GhostPanelRestoreMode) => void;
} {
  const [mode, setModeState] = useState<GhostPanelRestoreMode>(getGhostPanelRestoreMode);
  const setMode = useCallback((next: GhostPanelRestoreMode) => {
    setGhostPanelRestoreMode(next);
  }, []);

  useEffect(() => {
    const sync = () => setModeState(getGhostPanelRestoreMode());
    return subscribe(sync);
  }, []);

  return { mode, setMode };
}

/** 仅测试用。 */
export function __resetGhostPanelRestoreModeForTest(): void {
  memoryValue = null;
  listeners.clear();
  if (storageSubscribed) {
    window.removeEventListener('storage', onStorage);
    storageSubscribed = false;
  }
}
