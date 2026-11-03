import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Tip, type TipProps } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import '../ui/button.css';

/**
 * ChromeIconButton —— 标题栏 28px 圆形图标按钮基元。
 *
 * 统一 TabBar、SidebarWindowLayout、SidebarTabWindowLayout
 * 四处的按钮视觉规格：
 *   - 28×28 圆形，透明底
 *   - 图标 14px
 *   - titlebar-icon 颜色 + surface-hover 悬浮态
 *
 * 快捷键逻辑由各调用方自行注册，不进入本组件。
 */
const CHROME_ICON_BUTTON_CLASS =
  'cindy-button-frame inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--titlebar-icon)] transition-colors enabled:hover:[--button-face-bg:var(--surface-hover)] enabled:active:[--button-face-bg:var(--surface-hover)] enabled:hover:text-[var(--text-primary)]';

export function ChromeIconButton({
  children,
  className,
  tooltip,
  disabledTooltip,
  tooltipSide,
  tooltipDelay,
  title,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: ReactNode;
  tooltip?: ReactNode;
  /** 置灰时的 tooltip：说明为什么不可用（DESIGN §14.6），不传则沿用 tooltip。 */
  disabledTooltip?: ReactNode;
  tooltipSide?: TipProps['side'];
  tooltipDelay?: number;
}) {
  const accessibleLabel = rest['aria-label'];
  const tooltipText =
    (rest.disabled ? disabledTooltip : undefined) ??
    tooltip ??
    title ??
    (typeof accessibleLabel === 'string' ? accessibleLabel : undefined);
  const disabledLabel =
    typeof tooltipText === 'string'
      ? tooltipText
      : typeof accessibleLabel === 'string'
        ? accessibleLabel
        : undefined;
  const button = (
    <button
      type="button"
      className={cn(CHROME_ICON_BUTTON_CLASS, className)}
      {...rest}
      aria-hidden={rest.disabled ? true : undefined}
    >
      {children}
    </button>
  );

  return (
    <Tip text={tooltipText} side={tooltipSide} delay={tooltipDelay}>
      {rest.disabled ? (
        <span
          role="button"
          aria-disabled="true"
          aria-label={disabledLabel}
          tabIndex={0}
          className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {button}
        </span>
      ) : (
        button
      )}
    </Tip>
  );
}
