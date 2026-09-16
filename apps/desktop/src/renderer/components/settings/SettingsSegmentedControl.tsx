import { useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Card-anchored single selection; DESIGN.md §4 Settings segmented controls. */
export function SettingsSegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  disabled = false,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: {
  value: T | null;
  options: readonly { value: T; label: ReactNode }[];
  onValueChange: (value: T) => void;
  disabled?: boolean;
  id?: string;
  'aria-label': string;
  'aria-describedby'?: string;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-disabled={disabled || undefined}
      className="flex h-8 w-fit shrink-0 items-center gap-0.5 rounded-full bg-[var(--surface-chip)] p-[3px]"
    >
      {options.map((option, index) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            tabIndex={index === Math.max(0, selectedIndex) ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => {
              if (disabled) return;
              const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
              let next: number;
              switch (event.key) {
                case 'ArrowRight':
                  next = index + (rtl ? -1 : 1);
                  break;
                case 'ArrowLeft':
                  next = index + (rtl ? 1 : -1);
                  break;
                case 'ArrowDown':
                  next = index + 1;
                  break;
                case 'ArrowUp':
                  next = index - 1;
                  break;
                case 'Home':
                  next = 0;
                  break;
                case 'End':
                  next = options.length - 1;
                  break;
                default:
                  return;
              }
              event.preventDefault();
              next = (next + options.length) % options.length;
              buttons.current[next]?.focus();
              onValueChange(options[next].value);
            }}
            className={cn(
              'flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-full border border-transparent px-3 text-12 leading-none transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? 'border-[var(--border-default)] bg-[var(--surface-elevated)] font-medium text-[var(--settings-section-title)]'
                : 'font-normal text-[var(--text-secondary)] enabled:hover:text-[var(--text-primary)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
