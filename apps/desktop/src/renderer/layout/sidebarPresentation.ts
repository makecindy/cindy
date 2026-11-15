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
): SidebarPresentation {
  const [presentation, setPresentation] = useState<SidebarPresentation>({ collapsed, instant: false });
  const expansion = useRef(expansionWidth);
  expansion.current = expansionWidth;
  const previous = useRef<boolean | null>(null);
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
    // Saved native bounds are standalone; a restored-open sidebar expands normally.
    const openingFromMount = ready && wasCollapsed === null && !collapsed;
    if (!ready || (wasCollapsed === null && collapsed) || !resize || width <= 0) {
      if (!ready && wasCollapsed === false && resize) {
        void resize(0).catch(() => undefined);
      }
      setPresentation({ collapsed, instant: true,
        ...(ready && !collapsed && width > 0 ? { expandedWidth: width } : {}),
      });
      return;
    }
    // The sidebar consumes this same snapshot, so it cannot begin its own animation yet.
    setPresentation({ ...latest.current, ...(openingFromMount ? { collapsed: true } : {}), frozenWidth: width });
    const viewport = window.innerWidth;
    void resize(collapsed ? 0 : expansion.current()).then((delta) => {
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

  useLayoutEffect(() => () => {
    generation.current++;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    // StrictMode's second mount must establish a fresh baseline.
    previous.current = null;
  }, []);
  return presentation;
}
