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

/** `/cc-agent` 下的静态段：不是任务会话，没有可恢复的右栏记忆。 */
const NON_SESSION_SEGMENTS = new Set(['new', 'new-dialogue', 'scheduled', 'files', 'orca', 'boot']);

/**
 * 内容区当前是否落在任务路由上（`/cc-agent/:sessionId`）。只看 URL：子视图声明
 * 「右栏在场」要等它自己的 effect，冷启动首帧读不到，不能用作「启动落在哪个路由」
 * 的判据。启动恢复与从无侧栏路由落地是两条不同的路，见 `useSidebarPresentation`。
 */
export function isTaskSessionRoute(pathname: string): boolean {
  const [, root, segment, nested] = pathname.split('/');
  if (root !== 'cc-agent' || !segment || nested !== undefined) return false;
  return !NON_SESSION_SEGMENTS.has(segment);
}

/**
 * 启动时先停在这些路径只是重定向：`/` 交给 MainEntryRedirect，`/cc-agent` 交给
 * CCAgentIndexRedirect 恢复上次的任务，副窗的 `/cc-agent/boot` 交给
 * SecondaryWindowBootGate，`/cc-agent/orca/:id` 与伙伴历史的 `/bots/.../history/:id`
 * 也各自由组件换成真正的任务路由。它们不是「用户落在无侧栏的页面上」，
 * 所以不能拿它们记「本次挂载先停在无侧栏路由」（模式见 `TRANSIENT_STARTUP_PATTERNS`）。
 */
const TRANSIENT_STARTUP_PATHS = new Set(['/', '/cc-agent', '/cc-agent/boot']);

/**
 * 会跳到任务路由的网关：先停在这些路径上，随后由各自的组件换成 `/cc-agent/:sessionId`。
 * 它们不是「用户落在无侧栏页面上」，所以按模式跳过，而不是逐个加进上面的集合
 * （`/cc-agent/orca/:id` → OrcaWorkflowRoute，`/bots/.../history/:id` → BotHistorySessionView）。
 */
const TRANSIENT_STARTUP_PATTERNS = [
  /^\/cc-agent\/orca\/[^/]+$/,
  /^\/bots\/(?:[^/]+|remote\/[^/]+\/[^/]+)\/history\/[^/]+$/,
];

/**
 * 内容区当前是否停在一个确定没有任务侧栏的页面（`/settings`、`/bots`、`/plugins`、
 * `/cc-agent/new` 等）。启动重定向路径不算，见 `TRANSIENT_STARTUP_PATHS`。
 */
export function isTasklessPageRoute(pathname: string): boolean {
  if (!pathname || TRANSIENT_STARTUP_PATHS.has(pathname)) return false;
  if (TRANSIENT_STARTUP_PATTERNS.some((pattern) => pattern.test(pathname))) return false;
  return !isTaskSessionRoute(pathname);
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
  /**
   * 内容区当前停在确定没有任务侧栏的页面上（`isTasklessPageRoute`）。启动时先停在这种
   * 页面、之后才被通知带到任务上，那次展开是任务自己的存档，不是用户开栏；启动重定向
   * 路径（`/`、`/cc-agent`）不算，它们随后会恢复上次的任务。
   */
  tasklessRoute = false,
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
  /** 这次挂载先停在「没有任务语境、也还没就绪」的路由（冷启动落在 /settings、/bots 等）。 */
  const sawTasklessRender = useRef(false);
  /** 当前这次展开是否由我们占用了窗口宽度（启动恢复 / 用户开栏）。 */
  const ownsWidth = useRef(false);
  /** 最近一次就绪渲染所属的任务；设置页接管会先清空 sessionKey，不能拿空档里的值。 */
  const lastReadySession = useRef(sessionKey);
  /** 离开就绪区间时的快照；null = 还没经历过就绪区间（首次挂载）。 */
  const beforeGap = useRef<{ ownsWidth: boolean; sessionKey: string } | null>(null);
  const generation = useRef(0);
  const frame = useRef<number | null>(null);
  const latest = useRef(presentation);
  latest.current = presentation;
  /** Viewport width before the last expansion — the size a collapse returns to. */
  const preExpandViewport = useRef<number | null>(null);

  useLayoutEffect(() => {
    const wasCollapsed = previous.current;
    const turnedUser = userToggle && !previousUserToggle.current;
    // 路由来源由调用方按 URL 同步给出：任务路由冷启动的首帧 sessionKey 还没填，
    // 不能拿它当「落在无侧栏路由」，否则启动恢复会被当成落地而不展开。
    if (!everReady.current && tasklessRoute) sawTasklessRender.current = true;
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
      if (autoSettled) {
        // The live rect just became the standalone base: the expansion that owned the old
        // width is gone in main, so whoever brings the panel back (a crashed global tab
        // returning, an agent re-opening it) must land passively instead of widening again.
        const snapshot = beforeGap.current;
        if (snapshot) beforeGap.current = { ...snapshot, ownsWidth: false };
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
    const requested = collapsed ? 0 : expansion.current();
    if (!collapsed) preExpandViewport.current = viewport;
    let active = true;
    let pollFrame: number | null = null;
    let growth: number | null = null;
    let replyAt: number | null = null;
    const listener = new AbortController();
    const stopWaiting = () => {
      active = false;
      listener.abort();
      if (pollFrame !== null) cancelAnimationFrame(pollFrame);
    };
    const settle = (observed: number) => {
      if (!active) return;
      // A superseded run (the user closed, or a Settings takeover landed) must not commit
      // its own visibility when its reply or viewport arrives: `active` alone only covers
      // this closure.
      if (id !== generation.current) {
        stopWaiting();
        return;
      }
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
      if (id !== generation.current) {
        stopWaiting();
        return;
      }
      const observed = window.innerWidth - viewport;
      if (observed === 0) return;
      if (growth !== null) {
        if (!atViewport(viewport + growth)) return;
        settle(growth);
        return;
      }
      if (collapsed ? observed > 0 : observed < 0) return;
      const expected = collapsed ? preExpandViewport.current : viewport + requested;
      if (expected === null || expected === undefined || !atViewport(expected)) return;
      settle(observed);
    };
    const poll = (): void => {
      if (!active) return;
      tryViewport();
      if (!active) return;
      // Once the reply arrives, bound the wait for a missing viewport update.
      if (replyAt !== null && performance.now() - replyAt >= 1000) { settle(growth ?? 0); return; }
      pollFrame = requestAnimationFrame(poll);
    };
    // Arm before the IPC call: the native bounds can land before the reply returns.
    window.addEventListener('resize', tryViewport, { signal: listener.signal });
    pollFrame = requestAnimationFrame(poll);
    void resize(requested).then((delta) => {
      if (!active) return;
      if (id !== generation.current) {
        stopWaiting();
        return;
      }
      replyAt = performance.now();
      growth = typeof delta === 'number' ? delta : 0;
      // No native change → nothing to wait for; run the ordinary animation now.
      if (growth === 0) { settle(0); return; }
      tryViewport();
    }).catch(() => {
      if (!active || id !== generation.current) {
        stopWaiting();
        return;
      }
      ownsWidth.current = false;
      stopWaiting();
      setPresentation({ collapsed, instant: false });
    });
  }, [collapsed, ready, root, sessionKey, userToggle, retractOnUnready, tasklessRoute]);

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
