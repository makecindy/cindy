/**
 * SidebarIconButton —— 收起侧栏的统一图标按钮。
 * 36×36 圆形点击区、18px 图标；颜色跟随主题。
 * 菜单与搜索触发器复用 SIDEBAR_RAIL_ICON_BUTTON_CLASS，
 * 由 data-state=open 表达展开态。
 */

import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { AttentionDot, type DotTone } from './AttentionDot';
import '../ui/button.css';

const BTN_BASE = 'cindy-button-frame flex shrink-0 items-center justify-center transition-colors';
const RAIL_GEOMETRY = 'h-9 w-9 rounded-full';
const IDLE = 'text-[hsl(var(--titlebar-icon))] enabled:hover:[--button-face-bg:var(--sidebar-item-hover)] enabled:active:[--button-face-bg:var(--sidebar-item-hover)]';
const ACTIVE = '[--button-face-bg:var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)]';

/** rail 图标钮类名(给 Radix trigger 直接套用):rail 几何(圆钮)+ 同套配色。 */
export const SIDEBAR_RAIL_ICON_BUTTON_CLASS = cn(
  BTN_BASE,
  RAIL_GEOMETRY,
  IDLE,
  'data-[state=open]:[--button-face-bg:var(--chat-input-chip-bg)] data-[state=open]:text-[var(--msg-assistant-text)]',
);

export interface SidebarIconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** aria-label 与可见 tooltip 文案。 */
  label: string;
  active?: boolean;
  /** 右上角 attention 状态点(如自动化未读)。 */
  showDot?: boolean;
  /** 状态点语义色,默认 done(绿);有失败未读时传 'error'。 */
  dotTone?: DotTone;
}

export function SidebarIconButton({
  icon: Icon,
  label,
  active = false,
  showDot = false,
  dotTone = 'done',
  className,
  disabled,
  title,
  ...rest
}: SidebarIconButtonProps) {
  const button = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      className={cn(
        BTN_BASE,
        RAIL_GEOMETRY,
        active ? ACTIVE : IDLE,
        className,
      )}
      {...rest}
      aria-hidden={disabled ? true : undefined}
    >
      <Icon size={18} />
      {showDot && <AttentionDot size={6} tone={dotTone} className="absolute right-1.5 top-1.5" />}
    </button>
  );

  return (
    <Tip text={title ?? label} side="right">
      {disabled ? (
        <span
          role="button"
          aria-disabled="true"
          aria-label={title ?? label}
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
