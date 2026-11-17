/**
 * useSidebarPeek —— 左侧栏「完全隐藏态 hover 临时浮出(peek)」状态机
 * ---------------------------------------------------------------------------
 * 侧栏被 ⌘B / 折叠按钮完全隐藏(w-0)后,鼠标悬停 ChromeActions 的折叠按钮
 * (触发钮)时,侧栏以 fixed overlay 抽屉形式临时滑出预览完整列表;指针离开
 * (既不在抽屉也不在触发钮上)后延迟收回;点击触发钮 / ⌘B = 固定展开(pin)。
 * 仅作用于「完全隐藏」态;rail 窄轨(isCollapsed=false)不触发。
 *
 * 状态机(4 态,正常展开/收起仍由 Sidebar 的 CSS width transition 承担):
 *   idle        → 无 peek(正常流内布局,含隐藏/rail/展开)
 *   peeking     → fixed 抽屉滑入并停留
 *   peekClosing → fixed 抽屉滑出动画中(200ms 后落回 idle)
 *   pinning     → peek 中被固定展开:抽屉 fixed 冻结,流内 spacer 跑宽度动画
 *                 推开主区,300ms 后一帧内交换回 static(消除 fixed→流内跳变)
 *
 * 关键机制:
 *   - hover intent:悬停触发钮 120ms 后才浮出,防手滑扫过误触;
 *   - hoverLock:任何收起动作(isCollapsed false→true)自动上锁,指针真正离开
 *     过触发钮才解锁 —— 防止收起瞬间指针恰停在按钮上原地回弹 peek;
 *   - 收回双路径:抽屉 onMouseLeave(relatedTarget 是触发钮则不收)+ peeking 期
 *     全局 pointermove 兜底(白名单含 Radix portal,否则抽屉内右键菜单/下拉
 *     一开、指针落在 portal 上就会误判「已离开」把抽屉收走);
 *   - pin 统一入口:peek 中 isCollapsed 翻 false(点击/⌘B/菜单)一律进 pinning,
 *     无特例分支;
 *   - 全部用 setTimeout 驱动、不依赖 transitionend —— reduced-motion 下动画
 *     归零也不会卡死,且可用 fake timers 单测。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type SidebarPeekState = 'idle' | 'peeking' | 'peekClosing' | 'pinning';

/** hover intent:悬停触发钮多久后浮出(对齐 useHoverOpenMenu 的量级)。 */
export const PEEK_OPEN_DELAY_MS = 120;
/** 指针离开抽屉/触发钮后的收回宽限(与 useHoverOpenMenu closeDelay 一致)。 */
export const PEEK_CLOSE_GRACE_MS = 160;
/** 滑出动画时长 —— 与 Sidebar.tsx peekClosing 的 duration-200 保持一致。 */
export const PEEK_CLOSE_ANIM_MS = 200;
/** pin 冻结时长 —— 覆盖流内 spacer 的 200ms 宽度动画 + 余量。 */
export const PEEK_PIN_FREEZE_MS = 300;

/** 全局 pointermove 兜底的「视为仍在 peek 交互内」白名单:抽屉、触发钮、
 *  Radix portal(右键菜单/下拉/hover 菜单)、对话框。 */
const PEEK_KEEPALIVE_SELECTOR =
  '[data-sidebar-peek-drawer],[data-sidebar-peek-trigger],[data-radix-popper-content-wrapper],[role="dialog"]';

export interface SidebarPeekTriggerProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  'data-sidebar-peek-trigger': string;
}

export interface SidebarPeekDrawerProps {
  onMouseEnter: () => void;
  onMouseLeave: (event: React.MouseEvent<HTMLElement>) => void;
  'data-sidebar-peek-drawer': string;
}

export interface UseSidebarPeekOptions {
  /** MainLayout 的持久化收起态(⌘B / 折叠按钮)。false 时 peek 永不触发。 */
  isCollapsed: boolean;
  /** 设置页等 Sidebar 不渲染的路由传 false —— 立即重置状态机。 */
  enabled: boolean;
}

export interface UseSidebarPeekResult {
  peekState: SidebarPeekState;
  /** peeking | peekClosing | pinning —— Sidebar 需要以 fixed 抽屉渲染。 */
  isPeekVisible: boolean;
  /** 展开在 ChromeActions 折叠按钮上。 */
  triggerProps: SidebarPeekTriggerProps;
  /** 展开在 Sidebar 的 aside 上(仅 peek 可见期需要生效)。 */
  drawerProps: SidebarPeekDrawerProps;
}

function eventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

export function useSidebarPeek({ isCollapsed, enabled }: UseSidebarPeekOptions): UseSidebarPeekResult {
  const [peekState, setPeekState] = useState<SidebarPeekState>('idle');
  // hoverLock 用 state 而非 ref:锁定期要挂全局 pointermove 解锁监听(见下方 effect)。
  const [hoverLocked, setHoverLocked] = useState(false);

  // 事件回调/定时器回调里读取最新值,避免闭包陈旧。
  const stateRef = useRef(peekState);
  stateRef.current = peekState;
  const isCollapsedRef = useRef(isCollapsed);
  isCollapsedRef.current = isCollapsed;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const hoverLockedRef = useRef(hoverLocked);
  hoverLockedRef.current = hoverLocked;

  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeGraceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeAnimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current);
      ref.current = null;
    }
  };
  const clearAllTimers = useCallback(() => {
    clearTimer(openTimer);
    clearTimer(closeGraceTimer);
    clearTimer(closeAnimTimer);
    clearTimer(pinTimer);
  }, []);

  // 卸载时清掉挂起的定时器,避免对已卸载组件 setState。
  useEffect(() => clearAllTimers, [clearAllTimers]);

  /** 立即进入滑出动画(peekClosing),200ms 后落回 idle。 */
  const beginClose = useCallback(() => {
    if (stateRef.current !== 'peeking') return;
    clearTimer(closeGraceTimer);
    setPeekState('peekClosing');
    closeAnimTimer.current = setTimeout(() => {
      closeAnimTimer.current = null;
      setPeekState('idle');
    }, PEEK_CLOSE_ANIM_MS);
  }, []);

  /** 排一个收回宽限:160ms 内指针回到抽屉/触发钮会被取消。 */
  const scheduleClose = useCallback(() => {
    if (stateRef.current !== 'peeking') return;
    if (closeGraceTimer.current) return;
    closeGraceTimer.current = setTimeout(() => {
      closeGraceTimer.current = null;
      beginClose();
    }, PEEK_CLOSE_GRACE_MS);
  }, [beginClose]);

  const cancelScheduledClose = useCallback(() => {
    clearTimer(closeGraceTimer);
  }, []);

  const handleTriggerEnter = useCallback(() => {
    if (!enabledRef.current || !isCollapsedRef.current || hoverLockedRef.current) return;
    const state = stateRef.current;
    if (state === 'peeking') {
      // 已浮出:指针回到触发钮,取消排队中的收回即可。
      cancelScheduledClose();
      return;
    }
    if (state === 'pinning') return;
    if (openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      // 120ms 后条件可能已变(被收起锁上/已 pin),重新校验。
      if (!enabledRef.current || !isCollapsedRef.current || hoverLockedRef.current) return;
      const current = stateRef.current;
      if (current !== 'idle' && current !== 'peekClosing') return;
      // 正在滑出时重新进入:掐掉收尾定时器直接回到 peeking(CSS transition 自然反向)。
      clearTimer(closeAnimTimer);
      setPeekState('peeking');
    }, PEEK_OPEN_DELAY_MS);
  }, [cancelScheduledClose]);

  const handleTriggerLeave = useCallback(() => {
    // 指针真正离开过触发钮 → 解除收起时上的 hover 锁(MivoCanvas 语义)。
    setHoverLocked(false);
    clearTimer(openTimer);
    scheduleClose();
  }, [scheduleClose]);

  const handleDrawerEnter = useCallback(() => {
    cancelScheduledClose();
  }, [cancelScheduledClose]);

  const handleDrawerLeave = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      // 移向触发钮不算离开(抽屉与按钮之间有缝隙)。
      const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
      if (next?.closest('[data-sidebar-peek-trigger]')) return;
      scheduleClose();
    },
    [scheduleClose],
  );

  // isCollapsed 翻转 —— peek 与「固定展开/收起」的汇合点:
  //   false→true(任何收起入口:折叠按钮 / ⌘B / 菜单):自动上 hover 锁;
  //   true→false 且 peek 可见中:统一视为 pin,进入 pinning 冻结过渡。
  const prevCollapsedRef = useRef(isCollapsed);
  useEffect(() => {
    const prev = prevCollapsedRef.current;
    prevCollapsedRef.current = isCollapsed;
    if (prev === isCollapsed) return;
    if (isCollapsed) {
      setHoverLocked(true);
      clearTimer(openTimer);
      // 边界:pinning 冻结期又被立刻收起 —— 直接落回 idle,让 aside 回到 w-0。
      if (stateRef.current === 'pinning') {
        clearTimer(pinTimer);
        setPeekState('idle');
      }
      return;
    }
    setHoverLocked(false);
    const state = stateRef.current;
    if (state === 'peeking' || state === 'peekClosing') {
      clearAllTimers();
      setPeekState('pinning');
      pinTimer.current = setTimeout(() => {
        pinTimer.current = null;
        setPeekState('idle');
      }, PEEK_PIN_FREEZE_MS);
    }
  }, [isCollapsed, clearAllTimers]);

  // enabled 关闭(如进入设置页)→ 整体重置。
  useEffect(() => {
    if (enabled) return;
    clearAllTimers();
    setPeekState('idle');
    setHoverLocked(false);
  }, [enabled, clearAllTimers]);

  // peeking 期全局 pointermove 兜底:指针落点不在白名单内 → 排收回;在 → 取消。
  // 覆盖 mouseleave 收不到的路径(如指针快速跳过抽屉边缘、经由 portal 菜单绕出)。
  useEffect(() => {
    if (peekState !== 'peeking') return;
    const onPointerMove = (event: PointerEvent) => {
      const element = eventTargetElement(event.target);
      if (element?.closest(PEEK_KEEPALIVE_SELECTOR)) {
        cancelScheduledClose();
      } else {
        scheduleClose();
      }
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [peekState, cancelScheduledClose, scheduleClose]);

  // peeking 期窗口失焦(⌘Tab 切走等收不到 mouseleave)→ 立即滑出。
  useEffect(() => {
    if (peekState !== 'peeking') return;
    const onBlur = () => beginClose();
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [peekState, beginClose]);

  // hover 锁的第二条解锁路径:指针移动且落点不在触发钮上 → 解锁。
  // 覆盖「⌘B 收起时指针根本不在按钮上」的情况(否则锁永远等不到 trigger mouseleave)。
  useEffect(() => {
    if (!hoverLocked) return;
    const onPointerMove = (event: PointerEvent) => {
      const element = eventTargetElement(event.target);
      if (element?.closest('[data-sidebar-peek-trigger]')) return;
      setHoverLocked(false);
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [hoverLocked]);

  return {
    peekState,
    isPeekVisible: peekState !== 'idle',
    triggerProps: {
      onMouseEnter: handleTriggerEnter,
      onMouseLeave: handleTriggerLeave,
      'data-sidebar-peek-trigger': 'true',
    },
    drawerProps: {
      onMouseEnter: handleDrawerEnter,
      onMouseLeave: handleDrawerLeave,
      'data-sidebar-peek-drawer': 'true',
    },
  };
}
