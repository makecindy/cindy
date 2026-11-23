import { createContext, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface SidebarPresentation {
  collapsed: boolean;
  instant: boolean;
  frozenWidth?: number;
  /** Initial expanded content width; native resizing is absorbed by the right pane. */
  expandedWidth?: number;
}
export const SidebarPresentationContext = createContext<SidebarPresentation | null>(null);

/**
 * 一次可见性请求要不要改写「这次展开由谁占用窗口宽度」。
 * 用户手势一律改写；程序请求（插件 / agent / MCP App 的 open）只在真的改变开合时改写——
 * 已经开着的面板再来一次幂等 open 不该把自己变成「程序强制展示」，否则下一次设置页往返
 * 会按 forcedReveal 跳过展开，窗口停在收起后的宽度、聊天被挤窄。
 */
export function rewritesRevealSource(opts: {
  visibility: 'open' | 'close';
  userInitiated: boolean;
  collapsed: boolean;
}): boolean {
  return opts.userInitiated || opts.collapsed !== (opts.visibility === 'close');
}

/**
 * 后台任务上的程序开栏要不要记为「被动展示」。
 * 只记第一次真的从收起变展开的那次：原本就开着的幂等请求，「开着」是用户自己那次，
 * 落地时该照常占窗口宽度。`wasCollapsed` 必须是写档之前读到的值——写完再读只会读到刚
 * 写的「已展开」，标记永远记不上，自动化开栏就会被当成用户开栏把窗口拉宽。
 */
export function passiveRevealOnBackgroundOpen(opts: {
  visibility: 'open' | 'close';
  userInitiated: boolean;
  wasCollapsed: boolean;
}): boolean {
  return opts.visibility === 'open' && !opts.userInitiated && opts.wasCollapsed;
}

/** Hold the old layout while native geometry crosses the IPC/compositor boundary. */
export function useSidebarPresentation(
  root: RefObject<HTMLDivElement | null>,
  collapsed: boolean,
  ready: boolean,
  expansionWidth: () => number,
  userToggle = true,
  /** 当前侧栏所属的任务（全局为 ''）；只用来判断就绪空档前后是不是同一个任务。 */
  sessionKey = '',
  /** 首次挂载时这次展开由视图强制（首帧程序展示），既不是启动恢复也不是用户开栏。 */
  passiveReveal = false,
  /** 面板失去就绪时是否把宽度还给窗口；自动收起（最后一个页签关掉等）保留窗口矩形。 */
  retractOnUnready = true,
): SidebarPresentation {
  const [presentation, setPresentation] = useState<SidebarPresentation>({ collapsed, instant: false });
  const expansion = useRef(expansionWidth);
  expansion.current = expansionWidth;
  const userResize = useRef(userToggle);
  userResize.current = userToggle;
  const passive = useRef(passiveReveal);
  passive.current = passiveReveal;
  const previous = useRef<boolean | null>(null);
  /** 上一次渲染的来源：分离窗口合并回主窗时只有来源会翻。 */
  const previousUserToggle = useRef(userToggle);
  /** 已经走过一次就绪渲染：之前的 false 是启动前的等待，不是路由离开。 */
  const everReady = useRef(false);
  /** 当前这次展开是否由我们占用了窗口宽度（启动恢复 / 用户开栏）。 */
  const ownsWidth = useRef(false);
  /** 最近一次就绪渲染所属的任务；设置页接管会先清空 sessionKey，不能拿空档里的值。 */
  const lastReadySession = useRef(sessionKey);
  /** 这次挂载先停在「没有任务语境、也还没就绪」的路由（冷启动落在 /settings、/bots 等）。 */
  const sawTasklessRender = useRef(false);
  /** 离开就绪区间时的快照；null = 还没经历过就绪区间（首次挂载）。 */
  const beforeGap = useRef<{ ownsWidth: boolean; sessionKey: string } | null>(null);
  const generation = useRef(0);
  const frame = useRef<number | null>(null);
  const latest = useRef(presentation);
  latest.current = presentation;

  useLayoutEffect(() => {
    const wasCollapsed = previous.current;
    const turnedUser = userToggle && !previousUserToggle.current;
    if (!sessionKey && !ready) sawTasklessRender.current = true;
    previousUserToggle.current = userToggle;
    previous.current = ready ? collapsed : null;
    if (ready) {
      everReady.current = true;
      lastReadySession.current = sessionKey;
    } else if (everReady.current && beforeGap.current === null) {
      // 只在空档的第一次记快照：设置页接管会先清 sessionKey，之后的值已不代表原任务。
      beforeGap.current = { ownsWidth: ownsWidth.current, sessionKey: lastReadySession.current };
    }
    // 分离窗口合并回主窗只翻来源：面板本来就开着，而它的宽度在分离时已经交还窗口。
    // 这一次必须当成真正的用户开栏去拉宽，否则合并回来后侧栏被挤在独立窗口的宽度里。
    const userReopened = ready && !collapsed && turnedUser && !ownsWidth.current;
    if (ready && wasCollapsed === collapsed && !userReopened) return;
    const id = ++generation.current;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const resize = window.electronAPI.windowSidebarExpansion;
    const width = root.current?.getBoundingClientRect().width ?? 0;
    // Saved native bounds are standalone; a restored-open sidebar expands normally.
    const openingFromMount = ready && wasCollapsed === null && !collapsed;
    // 路由离开（设置页接管等）前侧栏是程序打开的，窗口本来就没变宽；回来后也不能
    // 把它当成用户开栏去拉宽窗口——否则一次设置页往返就把自动展示变成手点开栏。
    // 空档里换到了别的任务（系统岛 / 通知跳转）同理：那是那个任务的记忆状态，
    // 不是用户这次要开栏。只有用户直接点名要开（userToggle）才照常展开。
    const gap = beforeGap.current;
    // 先落在没有侧栏的路由（/settings、/bots 等）、之后才被通知带到任务上，和离开就绪区间
    // 再回来是同一种「落地」：这次展开来自任务自己的存档，不是用户开栏，窗口保持原宽。
    const relanded = openingFromMount && !userResize.current
      && (gap !== null ? gap.ownsWidth === false || gap.sessionKey !== sessionKey
        : sawTasklessRender.current);
    // 启动时按存档恢复展开照常占窗口宽度；但同一帧里由视图强制的展示（首帧 Orca
    // workers 等程序动作）只是把面板放出来，不能顺手把窗口拉宽。
    const forcedReveal = openingFromMount && !userResize.current && passive.current;
    if (ready && wasCollapsed === null) beforeGap.current = null;
    // A session switch restores that task's remembered visibility. Only the user's own
    // toggle may resize the native window; navigation keeps the width the user chose.
    const restored = !userResize.current && ready && wasCollapsed !== null;
    if (!ready || (wasCollapsed === null && collapsed) || !resize || width <= 0 || restored || relanded
      || forcedReveal) {
      // 这一帧没有占用窗口宽度（包括程序展示、路由就绪前的等待）：回来时也不再补展开。
      ownsWidth.current = false;
      // 面板自动收起（关掉最后一个页签等）时失去就绪：窗口保持原宽度，只把当前矩形
      // 登记成新的独立基准，不按「离开就绪区间」把窗口收窄。
      const autoSettled = !ready && wasCollapsed === false && !retractOnUnready;
      if (!ready && wasCollapsed === false && resize && retractOnUnready) {
        void resize(0).catch(() => undefined);
      }
      // The window keeps its width, so its live rect becomes the standalone base in main:
      // persistence and the next user open must not use the forgotten expansion.
      if (autoSettled || (restored && collapsed)) {
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
    let active = true;
    let pollFrame: number | null = null;
    const listener = new AbortController();
    const stopWaiting = () => {
      active = false;
      listener.abort();
      if (pollFrame !== null) cancelAnimationFrame(pollFrame);
    };
    void resize(collapsed ? 0 : expansion.current()).then((delta) => {
      // A superseded run (the user closed, or a Settings takeover landed) must not commit
      // its own visibility when its reply arrives: `active` alone only covers this closure.
      if (!active || id !== generation.current) return;
      const growth = typeof delta === 'number' ? delta : 0;
      const target = viewport + growth;
      const started = performance.now();
      const finish = () => {
        if (!active || id !== generation.current) return;
        // The invoke reply can arrive before Chromium observes the new native bounds.
        // A hidden/closing window must not retain a frozen layout indefinitely.
        if (growth !== 0 && Math.abs(window.innerWidth - target) > 1 && performance.now() - started < 1000) {
          if (pollFrame === null) {
            pollFrame = requestAnimationFrame(() => {
              pollFrame = null;
              finish();
            });
          }
          return;
        }
        stopWaiting();
        setPresentation({ collapsed, instant: growth !== 0,
          ...(!collapsed ? { expandedWidth: width + growth } : {}),
        });
      };
      finish();
      if (active) window.addEventListener('resize', finish, { signal: listener.signal });
    }).catch(() => {
      if (id !== generation.current) return;
      ownsWidth.current = false;
      setPresentation({ collapsed, instant: false });
    });
    // The next state change settles its own request; this one stops waiting for a reply
    // that would only describe a window rectangle nobody asked for anymore.
    return stopWaiting;
  }, [collapsed, ready, root, sessionKey, userToggle, retractOnUnready]);

  useLayoutEffect(() => () => {
    // StrictMode's second mount must establish a fresh baseline.
    previous.current = null;
    previousUserToggle.current = userToggle;
    everReady.current = false;
    beforeGap.current = null;
    lastReadySession.current = sessionKey;
    ownsWidth.current = false;
  }, []);
  return presentation;
}
