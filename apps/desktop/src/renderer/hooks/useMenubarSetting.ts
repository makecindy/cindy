import { useCallback, useEffect, useRef, useState } from 'react';

import type { MenubarState } from '../../shared/menubarQuota';

/** macOS menu bar quota item toggle; re-reads on focus because the panel can change it too. */
export function useMenubarSetting() {
  const [state, setState] = useState<MenubarState | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const supported = window.electronAPI?.platform === 'darwin';

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await window.electronAPI.windowBehavior.getMenubarState();
      if (mounted.current && generation.current === current) setState(next);
    } catch {
      if (mounted.current && generation.current === current) setState(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (supported) {
      void refresh();
      window.addEventListener('focus', refresh);
    }
    return () => {
      mounted.current = false;
      ++generation.current;
      window.removeEventListener('focus', refresh);
    };
  }, [supported, refresh]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    const current = ++generation.current;
    setBusy(true);
    setState((previous) => (previous ? { ...previous, enabled } : previous));
    try {
      const next = await window.electronAPI.windowBehavior.setMenubarEnabled(enabled);
      if (mounted.current && generation.current === current) setState(next);
    } catch {
      if (mounted.current && generation.current === current) void refresh();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [refresh]);

  return { available: supported && state?.available === true, state, busy, setEnabled };
}
