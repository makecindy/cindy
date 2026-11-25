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
  const latest = useRef(presentation);
  latest.current = presentation;
  /** Viewport width before the last expansion — the size a collapse returns to. */
  const preExpandViewport = useRef<number | null>(null);

  useLayoutEffect(() => {
    const wasCollapsed = previous.current;
    previous.current = ready ? collapsed : null;
    if (ready && wasCollapsed === collapsed) return;
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
    const requested = collapsed ? 0 : expansion.current();
    if (!collapsed) preExpandViewport.current = viewport;
    let active = true;
    let frame: number | null = null;
    let growth: number | null = null;
    const started = performance.now();
    const listener = new AbortController();
    const stopWaiting = () => {
      active = false;
      listener.abort();
      if (frame !== null) cancelAnimationFrame(frame);
    };
    const settle = (observed: number) => {
      if (!active) return;
      stopWaiting();
      setPresentation({ collapsed, instant: observed !== 0,
        ...(!collapsed ? { expandedWidth: width + observed } : {}),
      });
    };
    const atViewport = (candidate: number): boolean => Math.abs(window.innerWidth - candidate) <= 1;
    // On Linux/Wayland setBounds is synchronous and its reply outlives the viewport
    // landing, so a reply-gated unfreeze keeps the frozen layout up an extra frame.
    // Settle the moment the viewport reaches the expected size instead; only trust a
    // change that matches the resize we asked for, so an unrelated resize is ignored.
    const tryViewport = (): void => {
      if (!active) return;
      const observed = window.innerWidth - viewport;
      if (observed === 0) return;
      if (collapsed ? observed > 0 : observed < 0) return;
      if (growth !== null) {
        if (!atViewport(viewport + growth)) return;
        settle(growth);
        return;
      }
      const expected = collapsed ? preExpandViewport.current : viewport + requested;
      if (expected === null || expected === undefined || !atViewport(expected)) return;
      settle(observed);
    };
    const poll = (): void => {
      if (!active) return;
      tryViewport();
      if (!active) return;
      // A hidden/closing window must not retain a frozen layout indefinitely.
      if (performance.now() - started >= 1000) { settle(growth ?? window.innerWidth - viewport); return; }
      frame = requestAnimationFrame(poll);
    };
    // Arm before the IPC call: the native bounds can land before the reply returns.
    window.addEventListener('resize', tryViewport, { signal: listener.signal });
    frame = requestAnimationFrame(poll);
    void resize(requested).then((delta) => {
      if (!active) return;
      growth = typeof delta === 'number' ? delta : 0;
      // No native change → nothing to wait for; run the ordinary animation now.
      if (growth === 0) { settle(0); return; }
      tryViewport();
    }).catch(() => {
      if (active) setPresentation({ collapsed, instant: false });
    });
    return stopWaiting;
  }, [collapsed, ready, root]);

  useLayoutEffect(() => () => {
    // StrictMode's second mount must establish a fresh baseline.
    previous.current = null;
  }, []);
  return presentation;
}
