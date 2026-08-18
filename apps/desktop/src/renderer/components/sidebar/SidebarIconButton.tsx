/**
 * SidebarIconButton —— 侧栏图标钮的统一原子。
 * ---------------------------------------------------------------------------
 * 与 HorizontalTabbar 的 tab 共用同一套几何/配色语言,让"顶部动作图标"和
 * 上方"Bot/Package/Bug 标签"在视觉上连成一套网格:
 *   - variant='grid'(展开态动作托盘):34×34 / rounded-[6px],左对齐 pl-4、gap-6
 *     由容器负责;落在标签栏正下方。
 *   - variant='rail'(78px 折叠态 rail):h-9 w-9 / rounded-full,保留 rail 既有
 *     圆钮形状,仅统一配色。
 * 配色三态(两 variant 共用,均取自 HorizontalTabbar / themes/colors.ts):
 *   - idle :  icon text-[hsl(var(--titlebar-icon))],hover bg-sidebar-item-hover(侧栏玻璃面同款,2026-07-21 修正 update-btn-hover 误用)
 *   - active:  bg-[var(--chat-input-chip-bg)] + icon text-[var(--msg-assistant-text)]
 * icon 固定 size 18;showDot 在右上角画一个 attention 状态点(自动化未读,
 * dotTone 按全端统一色表:done 绿 / error 红)。
 *
 * 注意:这是普通 <button>。视图切换 / 对话搜索 各自包着 Radix 的
 * DropdownMenuTrigger / PopoverTrigger,**不**走本组件,而是复用导出的
 * SIDEBAR_GRID_ICON_BUTTON_CLASS(含 data-[state=open] 的 active 态),避免把
 * Radix Slot/ref 复杂度塞进来。
 */

import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { AttentionDot, type DotTone } from './AttentionDot';

const BTN_BASE = 'relative flex shrink-0 items-center justify-center transition-colors duration-150';
const GRID_GEOMETRY = 'h-[34px] w-[34px] rounded-[6px]';
const RAIL_GEOMETRY = 'h-9 w-9 rounded-full';
const IDLE = 'text-[hsl(var(--titlebar-icon))] hover:bg-sidebar-item-hover';
const ACTIVE = 'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)]';

/**
 * grid 图标钮类名(给 Radix trigger 直接套用):geometry + idle/hover + 用
 * data-[state=open] 表达 active(菜单/popover 打开时高亮),无需手动传 active。
 */
export const SIDEBAR_GRID_ICON_BUTTON_CLASS = cn(
  BTN_BASE,
  GRID_GEOMETRY,
  IDLE,
  'data-[state=open]:bg-[var(--chat-input-chip-bg)] data-[state=open]:text-[var(--msg-assistant-text)]',
);

/** rail 图标钮类名(给 Radix trigger 直接套用):rail 几何(圆钮)+ 同套配色。 */
export const SIDEBAR_RAIL_ICON_BUTTON_CLASS = cn(
  BTN_BASE,
  RAIL_GEOMETRY,
  IDLE,
  'data-[state=open]:bg-[var(--chat-input-chip-bg)] data-[state=open]:text-[var(--msg-assistant-text)]',
);

export interface SidebarIconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** aria-label 与可见 tooltip 文案。 */
  label: string;
  variant?: 'grid' | 'rail';
  active?: boolean;
  /** 右上角 attention 状态点(如自动化未读)。 */
  showDot?: boolean;
  /** 状态点语义色,默认 done(绿);有失败未读时传 'error'。 */
  dotTone?: DotTone;
}

export function SidebarIconButton({
  icon: Icon,
  label,
  variant = 'grid',
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
        variant === 'grid' ? GRID_GEOMETRY : RAIL_GEOMETRY,
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
          className={cn(
            'inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            variant === 'grid' ? 'rounded-[6px]' : 'rounded-full',
          )}
        >
          {button}
        </span>
      ) : (
        button
      )}
    </Tip>
  );
}
