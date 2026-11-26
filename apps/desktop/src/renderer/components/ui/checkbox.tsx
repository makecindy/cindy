/**
 * Checkbox —— 设置里「点保存才生效」的选项（DESIGN.md §4 控件选用）。
 *
 * 改了立即生效的设置用 Switch；表单、草稿、批量选择里的勾选项用本组件。
 * 原生 input 保留键盘、表单和读屏语义；统一 16px、主题强调色、焦点环与禁用态。
 * indeterminate 映射到原生属性（只能由脚本设置），用于「部分选中」。
 *
 * shape="circle" 只用于消息多选（分享对话选择，主人裁决 2026-11-25）：仍是原生 input，
 * 外观由 CheckCircleMark 画。按钮里需要同款指示时单独用 CheckCircleMark（纯装饰），
 * 不要在 button 里嵌 input。
 */

import * as React from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';

export type CheckCircleSize = 16 | 20;

/** Round check visual: decorative only, the owning control carries the semantics. */
export function CheckCircleMark({
  checked,
  size,
  className,
}: {
  checked: boolean;
  size: CheckCircleSize;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full transition-colors',
        size === 20 ? 'size-5' : 'size-4 border',
        checked
          ? cn(
              'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]',
              size === 16 && 'border-[var(--accent-cta-bg-pure)]',
            )
          : size === 20
            ? 'border border-[var(--border-default)] bg-transparent'
            : 'border-[var(--text-tertiary)] bg-transparent',
        className,
      )}
    >
      {checked ? <Check size={size === 20 ? 12 : 11} strokeWidth={2.5} aria-hidden /> : null}
    </span>
  );
}

type CheckboxBaseProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'>;

export type CheckboxProps = CheckboxBaseProps &
  (
    | {
        shape?: 'square';
        size?: never;
        /** Partially selected group; also exposed as aria-checked="mixed". */
        indeterminate?: boolean;
      }
    | {
        /** Message multi-select only (DESIGN.md §4, Switch or Checkbox). */
        shape: 'circle';
        size?: CheckCircleSize;
        /** The drawn mark follows this value, so the circle is always controlled. */
        checked: boolean;
        indeterminate?: never;
      }
  );

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate = false, onChange, shape = 'square', size = 20, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLInputElement | null>(null);
    // A click clears the native flag even when the prop stays true (e.g. a bulk toggle that
    // cannot change a partial group), so re-apply the prop after every render, not only when
    // it changes.
    React.useLayoutEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = indeterminate;
    });
    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange?.(event);
      // The parent may not re-render at all (unchanged state); restore the flag right away.
      event.currentTarget.indeterminate = indeterminate;
    };
    const setRef = React.useCallback((node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    }, [forwardedRef]);
    if (shape === 'circle') {
      return (
        <span className={cn('relative inline-flex shrink-0', className)}>
          <input
            ref={setRef}
            type="checkbox"
            className={cn(
              'peer absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-full',
              'outline-none disabled:cursor-not-allowed',
            )}
            {...props}
            onChange={handleChange}
          />
          <CheckCircleMark
            checked={props.checked === true}
            size={size}
            className={cn(
              'pointer-events-none peer-disabled:opacity-60',
              'peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--focus-ring)]',
              size === 20 && !props.checked && 'peer-enabled:peer-hover:border-[var(--text-secondary)]',
            )}
          />
        </span>
      );
    }
    return (
      <input
        ref={setRef}
        type="checkbox"
        aria-checked={indeterminate ? 'mixed' : undefined}
        className={cn(
          'size-4 shrink-0 cursor-pointer accent-[var(--text-primary)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-1',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...props}
        onChange={handleChange}
      />
    );
  },
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
