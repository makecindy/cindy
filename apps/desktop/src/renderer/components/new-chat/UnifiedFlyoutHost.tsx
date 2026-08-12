import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import type { ProviderView } from '@cindy/model-providers';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { cn } from '@/lib/utils';

import { ProviderMark } from './ModelSelector';
import { computeFlyoutPlacement } from './unifiedModelSelection';

/** 浮层宽度 —— 与设计稿 v4 一致(264px)。 */
export const FLYOUT_WIDTH = 264;

/** rail 上的供应商标 —— 复用行内同一套图标规则(ModelSelector.ProviderMark)。 */
export function ProviderRailMark({
  providerId,
  providers,
}: {
  providerId: string;
  providers: readonly ProviderView[];
}) {
  const provider = providers.find((entry) => entry.id === providerId);
  return (
    <ProviderMark
      providerId={providerId}
      {...(provider?.name !== undefined ? { name: provider.name } : {})}
      {...(provider?.routing !== undefined ? { routing: provider.routing } : {})}
      {...(provider?.logoKind !== undefined ? { logoKind: provider.logoKind } : {})}
      colorClass="text-current"
      withMargin={false}
    />
  );
}

/**
 * 浮层宿主 —— portal 到 body 并用 fixed 定位:
 *   - 面板本体带圆角 + `overflow-hidden`(滚动列表需要),浮层若留在面板内会被整块裁掉
 *     (规格 §1.3 的「圆角裁切放内层」在 portal 方案下天然满足);
 *   - Electron 的 app-region 只按布局矩形命中,故用真实 left/top 而非 transform 定位,
 *     并挂 `WINDOW_NO_DRAG_STYLE`,否则覆盖标题栏的区域会吞掉 pointer(与既有
 *     ModelOptionsFloatingPanel 同一条教训)。
 * 定位只在**锚点变化**时算一次(规格 §1.3「同锚点内不重算」,防滑杆改高度导致抖动)。
 */
export function UnifiedFlyoutHost({
  anchorEl,
  panelElement,
  flyoutRef,
  className,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  anchorEl: HTMLElement | null;
  panelElement: HTMLElement | null;
  flyoutRef: RefObject<HTMLDivElement | null>;
  className?: string;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children: ReactNode;
}) {
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  const anchorKeyRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!anchorEl || typeof window === 'undefined') return;
    if (anchorKeyRef.current === anchorEl && placement) return;
    anchorKeyRef.current = anchorEl;
    const frame = requestAnimationFrame(() => {
      const anchorRect = anchorEl.getBoundingClientRect();
      const panelRect = (panelElement ?? anchorEl).getBoundingClientRect();
      const size = flyoutRef.current?.getBoundingClientRect();
      setPlacement(
        computeFlyoutPlacement({
          anchor: anchorRect,
          panel: panelRect,
          size: { width: FLYOUT_WIDTH, height: size?.height ?? 240 },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [anchorEl, flyoutRef, panelElement, placement]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={flyoutRef}
      role="dialog"
      data-testid="unified-model-config-flyout"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      // 键盘用户经 ← 键进来时没有 pointerenter:焦点进浮层同样要按住不收,
      // 焦点离开浮层(且没落回浮层内部)才走同一条 grace period 收起。
      onFocusCapture={onPointerEnter}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        onPointerLeave();
      }}
      className={cn(
        'fixed z-50 rounded-[16px] border p-3.5 shadow-[var(--shadow-menu)]',
        'border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)]',
        'transition-[top] duration-150 ease-out motion-reduce:transition-none',
        className,
      )}
      style={{
        width: FLYOUT_WIDTH,
        left: placement?.left ?? -9999,
        top: placement?.top ?? -9999,
        visibility: placement ? undefined : 'hidden',
        ...WINDOW_NO_DRAG_STYLE,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
