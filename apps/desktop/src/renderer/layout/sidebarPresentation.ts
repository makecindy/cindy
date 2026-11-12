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
  userToggle = true,
): SidebarPresentation {
  const [presentation, setPresentation] = useState<SidebarPresentation>({ collapsed, instant: false });
  const expansion = useRef(expansionWidth);
  expansion.current = expansionWidth;
  const userResize = useRef(userToggle);
  userResize.current = userToggle;
  const previous = useRef<boolean | null>(null);
  /** 已经走过一次就绪渲染：之前的 false 是启动前的等待，不是路由离开。 */
  const everReady = useRef(false);
  /** 当前这次展开是否由我们占用了窗口宽度（启动恢复 / 用户开栏）。 */
  const ownsWidth = useRef(false);
  /** 离开就绪区间前的 ownsWidth；null = 还没经历过就绪区间（首次挂载）。 */
  const beforeGap = useRef<boolean | null>(null);
  const generation = useRef(0);
  const frame = useRef<number | null>(null);
  const latest = useRef(presentation);
  latest.current = presentation;

  useLayoutEffect(() => {
    const wasCollapsed = previous.current;
    previous.current = ready ? collapsed : null;
    if (ready) everReady.current = true;
    else if (everReady.current) beforeGap.current = ownsWidth.current;
    if (ready && wasCollapsed === collapsed) return;
    const id = ++generation.current;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const resize = window.electronAPI.windowSidebarExpansion;
    const width = root.current?.getBoundingClientRect().width ?? 0;
    // Saved native bounds are standalone; a restored-open sidebar expands normally.
    const openingFromMount = ready && wasCollapsed === null && !collapsed;
    // 路由离开（设置页接管等）前侧栏是程序打开的，窗口本来就没变宽；回来后也不能
    // 把它当成用户开栏去拉宽窗口——否则一次设置页往返就把自动展示变成手点开栏。
    const relanded = openingFromMount && beforeGap.current === false;
    if (ready && wasCollapsed === null) beforeGap.current = null;
    // A session switch restores that task's remembered visibility. Only the user's own
    // toggle may resize the native window; navigation keeps the width the user chose.
    const restored = !userResize.current && ready && wasCollapsed !== null;
    if (!ready || (wasCollapsed === null && collapsed) || !resize || width <= 0 || restored || relanded) {
      // 这一帧没有占用窗口宽度（包括程序展示、路由就绪前的等待）：回来时也不再补展开。
      ownsWidth.current = false;
      if (!ready && wasCollapsed === false && resize) {
        void resize(0).catch(() => undefined);
      }
      // The window keeps its width, so its live rect becomes the standalone base in main:
      // persistence and the next user open must not use the forgotten expansion.
      if (restored && collapsed) {
        void window.electronAPI.windowSidebarSettle?.().catch(() => undefined);
      }
      setPresentation({ collapsed, instant: true,
        ...(ready && !collapsed && width > 0 ? { expandedWidth: width } : {}),
      });
      return;
    }
    // The sidebar consumes this same snapshot, so it cannot begin its own animation yet.
    setPresentation({ ...latest.current, ...(openingFromMount ? { collapsed: true } : {}), frozenWidth: width });
    // 收起本来就是交还宽度；只有展开才占用窗口。
    ownsWidth.current = !collapsed;
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
      if (id !== generation.current) return;
      ownsWidth.current = false;
      setPresentation({ collapsed, instant: false });
    });
  }, [collapsed, ready, root]);

  useLayoutEffect(() => () => {
    generation.current++;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    // StrictMode's second mount must establish a fresh baseline.
    previous.current = null;
    everReady.current = false;
    beforeGap.current = null;
    ownsWidth.current = false;
  }, []);
  return presentation;
}
