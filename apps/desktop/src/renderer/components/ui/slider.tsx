/**
 * Slider —— Radix Slider 包装。
 *
 * 颜色走主题 token: track=surface-chip, range=accent-emphasis,
 * thumb=surface-elevated + border-default。用于设置页数值型偏好。
 */

import * as React from 'react';
import * as SliderPrimitives from '@radix-ui/react-slider';

import { cn } from '@/lib/utils';

const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitives.Root>
>(
  (
    {
      className,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabelledBy,
      'aria-describedby': ariaDescribedBy,
      'aria-valuetext': ariaValueText,
      ...props
    },
    ref,
  ) => (
    <SliderPrimitives.Root
      ref={ref}
      className={cn(
        'relative flex w-full touch-none select-none items-center',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitives.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[var(--surface-chip)]">
        <SliderPrimitives.Range className="absolute h-full rounded-full bg-[var(--accent-emphasis)]" />
      </SliderPrimitives.Track>
      <SliderPrimitives.Thumb
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-valuetext={ariaValueText}
        className={cn(
          'block h-4 w-4 rounded-full border border-[var(--border-default)]',
          'bg-[var(--surface-elevated)]',
          'transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--settings-theme-card-bg)]',
          'disabled:pointer-events-none',
        )}
      />
    </SliderPrimitives.Root>
  ),
);
Slider.displayName = SliderPrimitives.Root.displayName;

export { Slider };
