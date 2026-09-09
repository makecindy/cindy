import * as React from 'react';
import { LoaderCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Minimal icon contract: lucide icons, Agent 身份的 ClaudeMark / CodexMark 与模型
 * 厂牌的 AnthropicMark / OpenAIMark 都满足,后续迁移无需改变 API。
 */
export type SpinnerIconComponent = React.ComponentType<{
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
  'aria-hidden'?: React.AriaAttributes['aria-hidden'];
  focusable?: React.SVGAttributes<SVGElement>['focusable'];
}>;

export interface SpinnerProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Icon to render inside the static SVG slot. Defaults to LoaderCircle (= Loader2). */
  icon?: SpinnerIconComponent;
  /** Icon size in px, forwarded to the icon component. */
  size?: number | string;
  /** Lucide stroke width override. */
  strokeWidth?: number | string;
  /** Whether the wrapper should spin. False renders the same icon without animation. */
  spinning?: boolean;
}

/**
 * Spinner keeps the infinite rotation on an HTML wrapper instead of the SVG.
 *
 * DESIGN.md 设计实现规范(常驻动画必须 compositor-only,SVG 一律静止):
 * CSS animation on SVG roots or SVG children wakes the renderer main thread every
 * frame. Keep the icon SVG static, and animate only this inline-flex wrapper with
 * `animate-spinner` (`--motion-spinner-cycle`, DESIGN.md §14.4)。不复用 Tailwind
 * `animate-spin` 的硬编码 1s。
 *
 * Usage notes:
 * - The wrapper hugs the icon, so pass `size` only — don't add h/w classes that
 *   duplicate it (a larger slot box like `size-4` around a smaller icon is fine).
 * - The svg sits one level deeper than a bare icon; parent `[&>svg]:` direct-child
 *   selectors won't match it — use `[&_svg]` or style the Spinner wrapper instead.
 * - Don't put translate utilities on the Spinner itself: while spinning, the
 *   `animate-spinner` keyframe overwrites `transform` every frame. Nudge an outer
 *   static wrapper instead (never the svg inside — it would orbit off-center).
 */
const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  {
    icon: Icon = LoaderCircle,
    size = 16,
    strokeWidth,
    spinning = true,
    className,
    ...props
  },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        spinning && 'animate-spinner motion-reduce:animate-none',
        className,
      )}
      {...props}
    >
      <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" focusable="false" />
    </span>
  );
});

export { Spinner };
