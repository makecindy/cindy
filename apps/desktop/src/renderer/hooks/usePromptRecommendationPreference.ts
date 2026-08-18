import { useCallback, useEffect, useState } from 'react';

export const PROMPT_RECOMMENDATION_KEY = 'prompt-recommendation-enabled';

/** Module-level memory is the synchronous source of truth for event handlers. */
let memoryValue: boolean | null = null;

const listeners = new Set<() => void>();

function readFromStorage(): boolean {
  try {
    return localStorage.getItem(PROMPT_RECOMMENDATION_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function getPromptRecommendationPreference(): boolean {
  if (memoryValue !== null) return memoryValue;
  memoryValue = readFromStorage();
  return memoryValue;
}

export function usePromptRecommendationPreference(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setState] = useState<boolean>(getPromptRecommendationPreference);

  const setEnabled = useCallback((next: boolean) => {
    memoryValue = next;
    setState(next);
    try {
      // 持久化用户显式选择，与「从未自定义」明确区分。
      // 若未来版本默认值变化，显式设为 true 的用户不受影响。
      localStorage.setItem(PROMPT_RECOMMENDATION_KEY, next ? 'true' : 'false');
    } catch {
      // localStorage 不可用 → 静默; 模块级内存值仍在本渲染进程内生效。
    }
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const sync = () => setState(getPromptRecommendationPreference());
    // 当所有 hook 实例都卸载后再次挂载时，跨窗口的 storage 事件可能已被错失，
    // 此时 memoryValue 仍是旧值。在添加第一个 listener 前从 storage 刷新缓存，
    // 确保多窗口切换场景下不会读到过期的偏好状态。
    if (listeners.size === 0) {
      memoryValue = readFromStorage();
      setState(memoryValue);
    }
    listeners.add(sync);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PROMPT_RECOMMENDATION_KEY) return;
      memoryValue = event.newValue !== 'false';
      sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { enabled, setEnabled };
}

/** Test-only reset for the module-level source of truth. */
export function _resetPromptRecommendationPreferenceForTests(): void {
  memoryValue = null;
  listeners.clear();
}