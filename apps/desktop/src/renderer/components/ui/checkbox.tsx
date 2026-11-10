/**
 * Checkbox —— 设置里「点保存才生效」的选项（DESIGN.md §4 控件选用）。
 *
 * 改了立即生效的设置用 Switch；表单、草稿、批量选择里的勾选项用本组件。
 * 原生 input 保留键盘、表单和读屏语义；统一 16px、主题强调色、焦点环与禁用态。
 * indeterminate 映射到原生属性（只能由脚本设置），用于「部分选中」。
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Partially selected group; also exposed as aria-checked="mixed". */
  indeterminate?: boolean;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate = false, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLInputElement | null>(null);
    React.useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = indeterminate;
    }, [indeterminate]);
    const setRef = React.useCallback((node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    }, [forwardedRef]);
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
      />
    );
  },
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
