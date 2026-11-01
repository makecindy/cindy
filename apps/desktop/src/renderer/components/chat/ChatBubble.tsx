import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { CHAT_BODY_CLASS } from './chatChrome';

/** Shared by group messages and the private task runtime, including their thread replies. */
export const CHAT_BUBBLE_COLUMN_CLASS = 'max-w-[min(720px,calc(100%-var(--chat-bubble-gutter,120px)))]';

export function ChatBubble({ speaker = 'assistant', bare = false, className, ...props }: ComponentProps<'div'> & {
  speaker?: 'assistant' | 'user';
  /** Ordinary task replies and an empty stream have no bubble surface. */
  bare?: boolean;
}) {
  return <div {...props} className={cn(
    CHAT_BODY_CLASS,
    bare ? 'w-full min-w-0' : 'relative min-w-0 max-w-full rounded-xl border',
    speaker === 'user'
      ? 'border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-4 py-3 text-[var(--msg-user-text)]'
      : cn('text-[var(--msg-assistant-text)]', !bare && 'border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-2.5'),
    className,
  )} />;
}
