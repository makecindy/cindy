import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import './segmented-control.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  id?: string;
  'aria-controls'?: string;
}

interface SegmentedControlProps<T extends string> {
  value: T | null;
  options: readonly SegmentedOption<T>[];
  onValueChange: (value: T) => void;
  'aria-label': string;
  disabled?: boolean;
  role?: 'radiogroup' | 'tablist';
  className?: string;
  optionClassName?: string;
  style?: CSSProperties;
  /** Scene density only; all variants share the same selection and interaction. */
  height?: number;
  optionHeight?: number;
  fullWidth?: boolean;
  prefix?: ReactNode;
  /** Model menus keep mouse focus in their composer; keyboard focus still works. */
  preserveMouseFocus?: boolean;
}

/** Desktop single selection. Business effects and panel ownership stay with the caller. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  disabled = false,
  role = 'radiogroup',
  'aria-label': ariaLabel,
  className,
  optionClassName,
  style,
  height = 32,
  optionHeight = 28,
  fullWidth = false,
  prefix,
  preserveMouseFocus = false,
}: SegmentedControlProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const [plate, setPlate] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const entry =
    selectedIndex >= 0 && !options[selectedIndex].disabled
      ? selectedIndex
      : options.findIndex((option) => !option.disabled);

  // Re-measure on selection, label/font changes and container resize (including hidden panels).
  useLayoutEffect(() => {
    const measure = () => {
      const button = value === null ? undefined : buttons.current.get(value);
      const next =
        button && button.offsetWidth > 0
          ? {
              x: button.offsetLeft,
              y: button.offsetTop,
              width: button.offsetWidth,
              height: button.offsetHeight,
            }
          : null;
      setPlate((previous) =>
        previous?.x === next?.x &&
        previous?.y === next?.y &&
        previous?.width === next?.width &&
        previous?.height === next?.height
          ? previous
          : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    buttons.current.forEach((button) => observer?.observe(button));
    return () => observer?.disconnect();
  }, [value, options]);

  return (
    <div
      ref={root}
      role={role}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-disabled={disabled || undefined}
      className={cn('cindy-segmented', fullWidth && 'cindy-segmented-full', className)}
      style={
        {
          '--segmented-height': `${height}px`,
          '--segmented-option-height': `${optionHeight}px`,
          ...style,
        } as CSSProperties
      }
    >
      {plate && (
        <span
          aria-hidden="true"
          className="cindy-segmented-plate"
          style={{
            transform: `translate(${plate.x}px, ${plate.y}px)`,
            width: plate.width,
            height: plate.height,
          }}
        />
      )}
      {prefix}
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              if (element) buttons.current.set(option.value, element);
              else buttons.current.delete(option.value);
            }}
            type="button"
            role={role === 'tablist' ? 'tab' : 'radio'}
            aria-selected={role === 'tablist' ? selected : undefined}
            aria-checked={role === 'radiogroup' ? selected : undefined}
            aria-label={option['aria-label']}
            aria-controls={option['aria-controls']}
            id={option.id}
            title={option.title}
            disabled={disabled || option.disabled}
            tabIndex={!disabled && index === entry ? 0 : -1}
            data-selected={selected}
            className={cn(
              'cindy-segmented-option relative inline-flex min-w-6 items-center justify-center gap-1.5 rounded-full border border-transparent px-3 text-12 font-medium leading-none outline-none',
              optionClassName,
            )}
            onMouseDown={(event) => {
              if (preserveMouseFocus) event.preventDefault();
            }}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => {
              if (disabled || option.disabled) return;
              const enabled = options.filter((item) => !item.disabled);
              const current = enabled.findIndex((item) => item.value === option.value);
              const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
              let next: number;
              switch (event.key) {
                case 'ArrowRight':
                  next = current + (rtl ? -1 : 1);
                  break;
                case 'ArrowLeft':
                  next = current + (rtl ? 1 : -1);
                  break;
                case 'ArrowDown':
                  next = current + 1;
                  break;
                case 'ArrowUp':
                  next = current - 1;
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
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
