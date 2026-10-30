/**
 * 「显示回复对应的消息」偏好（docs/product-rules/cindy-bots-runtime.md「回复对应的消息」）：打开后，
 * 伙伴的回复上方标出它回的是主人哪一条消息。默认关；只存 override（开时写 `true`，关回默认即删除），
 * 模块级内存值作跨实例真值、`storage` 事件跨窗口同步，与 useMessageNavRailPreference 同一做法。
 */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'bots.chat.showReplyTarget';

let memoryValue: boolean | null = null;
const listeners = new Set<() => void>();

function readPreference(): boolean {
  if (memoryValue !== null) return memoryValue;
  try {
    memoryValue = localStorage.getItem(STORAGE_KEY) === 'true';
    return memoryValue;
  } catch {
    return false;
  }
}

export function useBotReplyTargetPreference(): { enabled: boolean; setEnabled: (next: boolean) => void } {
  const [enabled, setLocal] = useState(readPreference);

  const setEnabled = useCallback((next: boolean) => {
    memoryValue = next;
    setLocal(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, 'true');
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable: the in-memory value still applies to this window.
    }
    listeners.forEach((listener) => listener());
  }, []);

  useEffect(() => {
    const sync = () => setLocal(readPreference());
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      memoryValue = null;
      sync();
    };
    listeners.add(sync);
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { enabled, setEnabled };
}
