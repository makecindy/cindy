import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** One card and spacing for the group textarea and the private task editor. */
export const COMPOSER_CONTENT_CLASS =
  'relative flex min-h-[86px] w-full flex-col justify-between px-[11px] pt-[11px] pb-[6px]';

export function ComposerCard({ framed = true, className, ...props }: ComponentProps<'div'> & { framed?: boolean }) {
  return <div {...props} className={cn(
    framed && 'rounded-xl border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)] transition-colors focus-within:border-[var(--chat-input-border-focus)]',
    className,
  )} />;
}
