import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';

const SidebarActivityNow = createContext<number | undefined>(undefined);

/** One in-memory clock for the visible sidebar; no task reads or per-project timers. */
export function SidebarActivityClock({ enabled, children }: {
  enabled: boolean;
  children: ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    let hostHidden = isWindowHidden();
    let timer: ReturnType<typeof setInterval> | undefined;
    const updateVisibility = () => {
      clearInterval(timer);
      timer = undefined;
      if (hostHidden || document.visibilityState === 'hidden') return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 60_000);
    };
    const off = window.electronAPI?.onWindowHiddenChange?.((hidden) => {
      hostHidden = hidden;
      updateVisibility();
    });
    document.addEventListener('visibilitychange', updateVisibility);
    updateVisibility();
    return () => {
      clearInterval(timer);
      off?.();
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, [enabled]);
  return <SidebarActivityNow.Provider value={enabled ? now : undefined}>{children}</SidebarActivityNow.Provider>;
}

export function useSidebarActivityNow(): number {
  // Standalone lists (rail panels, UI fixtures) still calculate using current time.
  return useContext(SidebarActivityNow) ?? Date.now();
}
