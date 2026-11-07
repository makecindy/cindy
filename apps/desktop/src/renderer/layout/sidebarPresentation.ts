import { createContext, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface SidebarPresentation {
  collapsed: boolean;
  instant: boolean;
  frozenWidth?: number;
  /** Initial expanded content width; native resizing is absorbed by the right pane. */
  expandedWidth?: number;
}
export const SidebarPresentationContext = createContext<SidebarPresentation | null>(null);

/** Hold the old layout while native geometry crosses the IPC/compositor boundary. */
export function useSidebarPresentation(
  root: RefObject<HTMLDivElement | null>,
  collapsed: boolean,
  ready: boolean,
  expansionWidth: () => number,
  sidebarWidth: () => number = () => 0,
): SidebarPresentation {
  const [presentation, setPresentation] = useState<SidebarPresentation>({ collapsed, instant: false });
  const expansion = useRef(expansionWidth);
  expansion.current = expansionWidth;
  const measureSidebar = useRef(sidebarWidth);
  measureSidebar.current = sidebarWidth;
  const openedGeometry = useRef<{ growth: number; sidebar: number } | null>(null);
  const pendingGrowth = useRef<number | null>(null);
  const pendingAdopt = useRef(false);
  const previous = useRef<boolean | null>(null);
  // The expansion was retracted because the sidebar became unavailable (e.g. a Settings route).
  const retracted = useRef(false);
  const generation = useRef(0);
  const frame = useRef<number | null>(null);
  const latest = useRef(presentation);
  latest.current = presentation;

  useLayoutEffect(() => {
    const wasCollapsed = previous.current;
    previous.current = ready ? collapsed : null;
    if (ready && wasCollapsed === collapsed) return;
    const id = ++generation.current;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const resize = window.electronAPI.windowSidebarExpansion;
    const width = root.current?.getBoundingClientRect().width ?? 0;
    // Returning to a sidebar route re-expands; only a first mount adopts the restored bounds.
    const reentering = ready && wasCollapsed === null && retracted.current && !collapsed;
    if (ready) retracted.current = false;
    if (!ready || (wasCollapsed === null && !reentering) || !resize || width <= 0) {
      if (!ready && wasCollapsed === false && resize) {
        retracted.current = true;
        openedGeometry.current = null;
        void resize(0).catch(() => undefined);
      }
      pendingAdopt.current = ready && !collapsed && width > 0 && !!resize;
      setPresentation({ collapsed, instant: true,
        ...(ready && !collapsed && width > 0 ? { expandedWidth: width } : {}),
      });
      return;
    }
    // The sidebar consumes this same snapshot, so it cannot begin its own animation yet.
    setPresentation({ ...latest.current, ...(reentering ? { collapsed: true } : {}), frozenWidth: width });
    const viewport = window.innerWidth;
    const geometry = openedGeometry.current;
    const shrink = collapsed && geometry
      ? Math.max(0, geometry.growth + measureSidebar.current() - geometry.sidebar) : undefined;
    void resize(collapsed ? 0 : expansion.current(), shrink).then((delta) => {
      if (id !== generation.current) return;
      const growth = typeof delta === 'number' ? delta : 0;
      const target = viewport + growth;
      const started = performance.now();
      const finish = () => {
        if (id !== generation.current) return;
        // The invoke reply can arrive before Chromium observes the new native bounds.
        // A hidden/closing window must not retain a frozen layout indefinitely.
        if (growth !== 0 && Math.abs(window.innerWidth - target) > 1 && performance.now() - started < 1000) {
          frame.current = requestAnimationFrame(finish);
          return;
        }
        frame.current = null;
        pendingGrowth.current = !collapsed && growth > 0 ? growth : null;
        if (collapsed) openedGeometry.current = null;
        setPresentation({ collapsed, instant: growth !== 0,
          ...(!collapsed ? { expandedWidth: width + growth } : {}),
        });
      };
      if (growth === 0) finish();
      else frame.current = requestAnimationFrame(finish);
    }).catch(() => {
      if (id === generation.current) setPresentation({ collapsed, instant: false });
    });
  }, [collapsed, ready, root]);

  useLayoutEffect(() => {
    if (pendingAdopt.current && !presentation.collapsed && presentation.frozenWidth === undefined) {
      pendingAdopt.current = false;
      const sidebar = measureSidebar.current();
      const id = generation.current;
      if (sidebar > 0) void window.electronAPI.windowSidebarExpansion?.(0, sidebar + 1, true).then((growth) => {
        if (id === generation.current && typeof growth === 'number' && growth > 0) {
          openedGeometry.current = { growth, sidebar };
        }
      }).catch(() => undefined);
    }
    if (pendingGrowth.current === null || presentation.collapsed || presentation.frozenWidth !== undefined) return;
    openedGeometry.current = { growth: pendingGrowth.current, sidebar: measureSidebar.current() };
    pendingGrowth.current = null;
  }, [presentation]);

  useLayoutEffect(() => () => {
    generation.current++;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    // StrictMode's second mount must establish a fresh baseline.
    previous.current = null;
  }, []);
  return presentation;
}
