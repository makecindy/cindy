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
  // Detaches the window resize listener of the in-flight transition (settled or superseded).
  const releaseResize = useRef<(() => void) | null>(null);
  const latest = useRef(presentation);
  latest.current = presentation;

  useLayoutEffect(() => {
    const wasCollapsed = previous.current;
    previous.current = ready ? collapsed : null;
    if (ready && wasCollapsed === collapsed) return;
    const id = ++generation.current;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    releaseResize.current?.();
    releaseResize.current = null;
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
      let settled = false;
      const settle = () => {
        if (id !== generation.current || settled) return;
        settled = true;
        frame.current = null;
        releaseResize.current?.();
        releaseResize.current = null;
        setPresentation({ collapsed, instant: growth !== 0,
          ...(!collapsed ? { expandedWidth: width + growth } : {}),
        });
      };
      const arrived = () => Math.abs(window.innerWidth - target) <= 1;
      // The native resize reaches the renderer as a window resize event in the frame
      // the new bounds are applied; rAF callbacks of that frame still read the old
      // innerWidth (they run before layout), so polling costs an extra frame or two
      // while the window already shows the frozen layout against new geometry.
      // Settling from the event unfreezes in that same frame; the poll stays as a
      // fallback for arrivals the event cannot cover (hidden/closing windows).
      const onResize = () => { if (arrived()) settle(); };
      const finish = () => {
        if (id !== generation.current || settled) return;
        // A hidden/closing window must not retain a frozen layout indefinitely.
        if (growth !== 0 && !arrived() && performance.now() - started < 1000) {
          frame.current = requestAnimationFrame(finish);
          return;
        }
        settle();
      };
      if (growth === 0 || arrived()) {
        // Nothing left to wait for: the reply carried no growth, or the viewport
        // already reflects the native bounds (a busy main process delivered the
        // reply late). Settle without scheduling a frame at all.
        settle();
        return;
      }
      releaseResize.current = () => window.removeEventListener('resize', onResize);
      window.addEventListener('resize', onResize);
      frame.current = requestAnimationFrame(finish);
    }).catch(() => {
      releaseResize.current?.();
      releaseResize.current = null;
      if (id === generation.current) setPresentation({ collapsed, instant: false });
    });
  }, [collapsed, ready, root]);

  useLayoutEffect(() => () => {
    generation.current++;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    releaseResize.current?.();
    releaseResize.current = null;
    // StrictMode's second mount must establish a fresh baseline.
    previous.current = null;
  }, []);
  return presentation;
}
