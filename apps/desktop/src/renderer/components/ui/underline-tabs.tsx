/**
 * UnderlineTabs —— 页面级导航的下划线标签条（DESIGN.md §4 Tabs，主人裁决 #9，2026-11-23）。
 *
 * 只给「切换整页内容」的导航用（插件详情、设置里的共享任务）；设置项、筛选和面板内的
 * 胶囊式切换仍用 SegmentedControl。标签面板由调用方渲染：每个 item 的 `id` /
 * `aria-controls` 与面板的 `role="tabpanel"`、`aria-labelledby` 互相对应。
 *
 * 键盘：Tab 只进入当前选中项（选中项不可用时进第一个可用项）；左右箭头（随 RTL 翻转）
 * 在可用项之间循环移动并直接切换，Home / End 到首尾；Space / Enter 保留原生按钮行为。
 */

import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface UnderlineTabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** 标签后的计数，次要文字色。 */
  count?: ReactNode;
  disabled?: boolean;
  /** 标签按钮 id，面板用它做 `aria-labelledby`。 */
  id?: string;
  'aria-controls'?: string;
}

export interface UnderlineTabsProps<T extends string> {
  value: T;
  items: readonly UnderlineTabItem<T>[];
  onValueChange: (value: T) => void;
  'aria-label': string;
  /** 整条不可用（例如提交中），保留选中项。 */
  disabled?: boolean;
  /** 加到 tablist 外层，只用于外边距和换行，不改标签本身。 */
  className?: string;
}

export function UnderlineTabs<T extends string>({
  value,
  items,
  onValueChange,
  'aria-label': ariaLabel,
  disabled = false,
  className,
}: UnderlineTabsProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const selectedIndex = items.findIndex((item) => item.value === value);
  const entry =
    selectedIndex >= 0 && !items[selectedIndex].disabled
      ? selectedIndex
      : items.findIndex((item) => !item.disabled);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: T) => {
    const enabled = items.filter((item) => !item.disabled);
    const index = enabled.findIndex((item) => item.value === current);
    if (index < 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = index + (rtl ? -1 : 1);
        break;
      case 'ArrowLeft':
        next = index + (rtl ? 1 : -1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = enabled.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = enabled[(next + enabled.length) % enabled.length];
    buttons.current.get(target.value)?.focus();
    if (target.value !== value) onValueChange(target.value);
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn(
        'flex flex-wrap items-end gap-x-6 border-b border-[var(--border-default)]',
        className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        const itemDisabled = disabled || item.disabled;
        return (
          <button
            key={item.value}
            ref={(element) => {
              if (element) buttons.current.set(item.value, element);
              else buttons.current.delete(item.value);
            }}
            id={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={item['aria-controls']}
            disabled={itemDisabled}
            tabIndex={!disabled && index === entry ? 0 : -1}
            // 和 SegmentedControl 一样，点当前项也回调，由调用方决定是否忽略。
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, item.value)}
            className={cn(
              '-mb-px inline-flex min-w-0 select-none items-baseline border-b-2 px-0.5 pb-2.5 pt-1 text-13 font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? 'border-[var(--text-primary)] text-[var(--text-primary)]'
                : 'border-transparent text-[var(--text-secondary)] enabled:hover:text-[var(--text-primary)]',
            )}
          >
            {item.label}
            {item.count !== undefined && item.count !== null && (
              <span className="ml-2 text-11 font-normal text-[var(--text-secondary)]">
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
