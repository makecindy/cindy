import { useCallback, useEffect, useState } from 'react';

import {
  getSessionRuntimeFallbackEnabled,
  setSessionRuntimeFallbackEnabled,
  subscribeSessionRuntimeFallbackEnabled,
} from '@/lib/sessionRuntimeFallbackStore';

export function useSessionRuntimeFallback() {
  const [enabled, setEnabledState] = useState(getSessionRuntimeFallbackEnabled);
  const [isCustomized, setIsCustomized] = useState(false);
  const setEnabled = useCallback((next: boolean) => setSessionRuntimeFallbackEnabled(next), []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker
      .sessionRuntimeFallbackGet()
      .then((settings) => {
        if (cancelled) return;
        setSessionRuntimeFallbackEnabled(settings.enabled);
        setEnabledState(settings.enabled);
        setIsCustomized(Boolean(settings.isCustomized));
      })
      .catch(() => undefined);
    const unsubscribe = subscribeSessionRuntimeFallbackEnabled(setEnabledState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { enabled, isCustomized, setEnabled, setIsCustomized };
}
