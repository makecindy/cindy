import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import { SIDEBAR_IDLE_COLLAPSE_KEY } from '../lib/sidebarCollapseConfig';
import { railPanelStore } from './railPanelStore';

const SidebarActivityNow = createContext<number | undefined>(undefined);
const SidebarIdleCollapse = createContext<{
  idleCollapseEnabled: boolean;
  setIdleCollapseEnabled: (enabled: boolean) => void;
}>({ idleCollapseEnabled: false, setIdleCollapseEnabled: () => {} });
// Portalled menus/dialogs keep their owning row: time does not advance while one is open.
const OPEN_OVERLAY_SELECTOR = '[data-state="open"]:is([role="menu"],[role="dialog"],[role="alertdialog"])';
const getRailSection = () => railPanelStore.getSnapshot().openSection;

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
  // Stopped (rail / file browser): time stays frozen; opening a rail panel samples once.
  const railSection = useSyncExternalStore(railPanelStore.subscribe, getRailSection);
  useLayoutEffect(() => {
    if (idleCollapseEnabled && !enabled && railSection) setNow(Date.now());
  }, [idleCollapseEnabled, enabled, railSection]);
  useEffect(() => {
    if (!clockEnabled) return;
    const root = interactionRoot?.current;
    let pointerInside = root?.matches(':hover') ?? false;
    let hostHidden = isWindowHidden();
    let timer: ReturnType<typeof setInterval> | undefined;
    const isVisible = () => !hostHidden && document.visibilityState !== 'hidden';
    const refresh = (focused = document.activeElement) => {
      if (!isVisible() || pointerInside ||
          document.querySelector(OPEN_OVERLAY_SELECTOR) ||
          (root?.contains(focused) && focused?.matches(':focus-visible'))) return;
      setNow(Date.now());
    };
    const enter = () => { pointerInside = true; };
    const leave = () => {
      pointerInside = false;
      refresh();
    };
    const focusOut = (event: FocusEvent) => {
      const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
      if (!root?.contains(next)) refresh(next);
    };
    const updateVisibility = (initial = false) => {
      clearInterval(timer);
      timer = undefined;
      if (!isVisible()) return;
      if (initial && !document.querySelector(OPEN_OVERLAY_SELECTOR)) setNow(Date.now());
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
      <SidebarActivityNow.Provider value={idleCollapseEnabled ? now : undefined}>
        {children}
      </SidebarActivityNow.Provider>
    </SidebarIdleCollapse.Provider>
  );
}

export function useSidebarIdleCollapse() {
  return useContext(SidebarIdleCollapse);
}

export function useSidebarActivityNow(): number {
  return useContext(SidebarActivityNow) ?? Date.now();
}
