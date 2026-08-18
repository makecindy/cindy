import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Tip, type TipProps } from '@/components/ui/tooltip';

/**
 * ChromeIconButton —— 标题栏 28px 圆形图标按钮基元。
 *
 * 统一 PanelChrome、TabBar、GhostPanelWindowLayout、SidebarWindowLayout
 * 四处的按钮视觉规格：
 *   - 28×28 圆形，透明底
 *   - 图标 14px
 *   - titlebar-icon 颜色 + surface-hover 悬浮态
 *
 * 快捷键逻辑由各调用方自行注册，不进入本组件。
 */
const CHROME_ICON_BUTTON_CLASS =
  'inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--titlebar-icon)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]';

export function ChromeIconButton({
  children,
  className,
  tooltip,
  tooltipSide,
  tooltipDelay,
  title,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children?: ReactNode;
  tooltip?: ReactNode;
  tooltipSide?: TipProps['side'];
  tooltipDelay?: number;
}) {
  const accessibleLabel = rest['aria-label'];
  const tooltipText =
    tooltip ?? title ?? (typeof accessibleLabel === 'string' ? accessibleLabel : undefined);
  const disabledLabel =
    typeof tooltipText === 'string'
      ? tooltipText
      : typeof accessibleLabel === 'string'
        ? accessibleLabel
        : undefined;
  const button = (
    <button
      type="button"
      className={[CHROME_ICON_BUTTON_CLASS, className].filter(Boolean).join(' ')}
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
