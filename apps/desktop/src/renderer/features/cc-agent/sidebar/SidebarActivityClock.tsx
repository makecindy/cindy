import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import { SIDEBAR_IDLE_COLLAPSE_KEY } from '../lib/sidebarCollapseConfig';

const SidebarActivityNow = createContext<number | undefined>(undefined);
const SidebarIdleCollapse = createContext({
  idleCollapseEnabled: false,
  setIdleCollapseEnabled: (_enabled: boolean) => {},
});

function loadIdleCollapse(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_IDLE_COLLAPSE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** One in-memory clock for the visible sidebar; no task reads or per-project timers. */
export function SidebarActivityClock({ enabled, interactionRoot, children }: {
  enabled: boolean;
  interactionRoot?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [idleCollapseEnabled, setPreference] = useState(loadIdleCollapse);
  const setIdleCollapseEnabled = useCallback((value: boolean) => {
    setPreference(value);
    try {
      localStorage.setItem(SIDEBAR_IDLE_COLLAPSE_KEY, String(value));
    } catch {
      // Keep the current window's choice even if storage is unavailable.
    }
  }, []);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === SIDEBAR_IDLE_COLLAPSE_KEY || event.key === null) {
        setPreference(loadIdleCollapse());
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const clockEnabled = enabled && idleCollapseEnabled;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!clockEnabled) return;
    const root = interactionRoot?.current;
    let pointerInside = root?.matches(':hover') ?? false;
    let hostHidden = isWindowHidden();
    let timer: ReturnType<typeof setInterval> | undefined;
    const isVisible = () => !hostHidden && document.visibilityState !== 'hidden';
    const refresh = (focused = document.activeElement) => {
      if (!isVisible() || pointerInside ||
          (root?.contains(focused) && focused?.matches(':focus-visible'))) return;
      setNow(Date.now());
    };
    const enter = () => { pointerInside = true; };
    const leave = () => {
      pointerInside = false;
      refresh();
    };
    const focusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && root?.contains(event.relatedTarget)) return;
      refresh(null);
    };
    const updateVisibility = (initial = false) => {
      clearInterval(timer);
      timer = undefined;
      if (!isVisible()) return;
      if (initial) setNow(Date.now());
      else refresh();
      timer = setInterval(refresh, 60_000);
    };
    const onVisibilityChange = () => updateVisibility();
    const off = window.electronAPI?.onWindowHiddenChange?.((hidden) => {
      hostHidden = hidden;
      updateVisibility();
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    root?.addEventListener('pointerenter', enter);
    root?.addEventListener('pointerleave', leave);
    root?.addEventListener('focusout', focusOut);
    updateVisibility(true);
    return () => {
      clearInterval(timer);
      off?.();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      root?.removeEventListener('pointerenter', enter);
      root?.removeEventListener('pointerleave', leave);
      root?.removeEventListener('focusout', focusOut);
    };
  }, [clockEnabled, interactionRoot]);
  const preference = useMemo(() => ({
    idleCollapseEnabled,
    setIdleCollapseEnabled,
  }), [idleCollapseEnabled, setIdleCollapseEnabled]);
  return (
    <SidebarIdleCollapse.Provider value={preference}>
      <SidebarActivityNow.Provider value={clockEnabled ? now : undefined}>
        {children}
      </SidebarActivityNow.Provider>
    </SidebarIdleCollapse.Provider>
  );
}

export function useSidebarIdleCollapse() {
  return useContext(SidebarIdleCollapse);
}

export function useSidebarActivityNow(): number {
  // Standalone lists (rail panels, UI fixtures) still calculate using current time.
  return useContext(SidebarActivityNow) ?? Date.now();
}
