/**
 * useHoverOpenMenu —— 让 Radix DropdownMenu「鼠标移上去就展开」的受控开合(侧栏「更多」用)。
 * ---------------------------------------------------------------------------
 *   - hover 触发按钮 → openDelay 后展开(防扫过误开);
 *   - 离开触发按钮 / 菜单内容 → closeDelay 后收起(给「按钮 → 菜单」的间隙留移动时间,
 *     进入内容会取消收起);
 *   - 点击触发按钮只开不关:hover 已展开时再点不会把菜单点掉。Radix 有两条关闭路径都要拦:
 *     Trigger 自身的 pointerdown toggle(我们的 onPointerDown 先跑并 preventDefault),以及
 *     非模态 Content 把「点触发按钮」判为点击外部(onInteractOutside 里 preventDefault);
 *   - 键盘、选中项、Esc、点击真正的外部仍走 Radix onOpenChange;
 *   - hover 展开不夺焦,收起也不把焦点还给触发按钮;点击 / 键盘展开保留默认聚焦。
 * 菜单须 modal={false}:模态会给 body 加 pointer-events:none,hover 收起无从判断。
 */

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

type OutsideInteractEvent = {
  detail: { originalEvent: { target: EventTarget | null } };
  preventDefault: () => void;
};

export function useHoverOpenMenu({
  openDelay = 90,
  closeDelay = 160,
  onOpenChange: onOpenChangeProp,
  onCloseAutoFocus: onCloseAutoFocusProp,
}: {
  openDelay?: number;
  closeDelay?: number;
  /** Every open / close, whether from hover, click, keyboard or selection. */
  onOpenChange?: (open: boolean) => void;
  /** Runs before the hover rule; a caller that prevents the default keeps that decision. */
  onCloseAutoFocus?: (event: Event) => void;
} = {}) {
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedViaHover = useRef(false);
  const onOpenChangeRef = useRef(onOpenChangeProp);
  onOpenChangeRef.current = onOpenChangeProp;

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const setOpen = useCallback((next: boolean) => {
    if (openRef.current === next) return;
    openRef.current = next;
    setOpenState(next);
    onOpenChangeRef.current?.(next);
  }, []);

  const scheduleOpen = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (openRef.current || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      openedViaHover.current = true;
      setOpen(true);
    }, openDelay);
  }, [openDelay, setOpen]);

  const scheduleClose = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (!openRef.current || closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, closeDelay);
  }, [closeDelay, setOpen]);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const onOpenChange = useCallback((next: boolean) => {
    clearTimers();
    if (next) openedViaHover.current = false;
    setOpen(next);
  }, [clearTimers, setOpen]);

  const onTriggerPointerDown = useCallback((event: ReactPointerEvent) => {
    if (openRef.current && event.button === 0 && !event.ctrlKey) event.preventDefault();
  }, []);

  const onInteractOutside = useCallback((event: OutsideInteractEvent) => {
    const target = event.detail.originalEvent.target;
    if (target instanceof Node && triggerRef.current?.contains(target)) event.preventDefault();
  }, []);

  const onOpenAutoFocus = useCallback((event: Event) => {
    if (openedViaHover.current) event.preventDefault();
  }, []);

  const onCloseAutoFocus = useCallback((event: Event) => {
    onCloseAutoFocusProp?.(event);
    if (openedViaHover.current) event.preventDefault();
  }, [onCloseAutoFocusProp]);

  return {
    open,
    onOpenChange,
    triggerProps: {
      ref: triggerRef,
      onMouseEnter: scheduleOpen,
      onMouseLeave: scheduleClose,
      onPointerDown: onTriggerPointerDown,
    },
    contentProps: {
      onMouseEnter: cancelClose,
      onMouseLeave: scheduleClose,
      onOpenAutoFocus,
      onCloseAutoFocus,
      onInteractOutside,
    },
  };
}
