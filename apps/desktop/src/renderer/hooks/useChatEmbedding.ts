/**
 * useChatEmbedding — React 包装, 订阅 chatEmbeddingStore 的变化。
 *
 * 真正 storage 在 lib/chatEmbeddingStore.ts, 本 hook 只接入 React 状态。
 * 形态与 useCompatMode 完全一致。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  getChatEmbeddingEnabled,
  setChatEmbeddingEnabled,
  subscribeChatEmbeddingEnabled,
} from '@/lib/chatEmbeddingStore';

export function useChatEmbedding(): {
  enabled: boolean;
  isCustomized: boolean;
  setEnabled: (next: boolean) => void;
  setIsCustomized: (next: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(getChatEmbeddingEnabled);
  const [isCustomized, setIsCustomized] = useState(false);

  const setEnabled = useCallback((next: boolean) => {
    setChatEmbeddingEnabled(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let refreshVersion = 0;
    const refresh = async () => {
      const version = ++refreshVersion;
      try {
        const settings = await window.electronAPI.maker.chatEmbeddingGet();
        if (cancelled || version !== refreshVersion) return;
        setChatEmbeddingEnabled(settings.enabled);
        setIsCustomized(Boolean(settings.isCustomized));
      } catch {
        // Main may still be starting; the next provider change or mount retries.
      }
    };
    const unsubscribe = subscribeChatEmbeddingEnabled(setEnabledState);
    const unsubscribeProviders = window.electronAPI.maker.onProvidersChanged(() => {
      void refresh();
    });
    void refresh();
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeProviders();
    };
  }, []);

  return { enabled, isCustomized, setEnabled, setIsCustomized };
}
