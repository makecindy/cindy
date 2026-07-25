import { Minus, Plus } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type InteractionPromptViewerState = 'expanded' | 'minimized';

interface InteractionPromptCardShellProps {
  viewerState: InteractionPromptViewerState;
  onViewerStateChange: (next: InteractionPromptViewerState) => void;
  /** Setup-style prompts can opt out when collapse/restore adds no value. */
  collapsible?: boolean;
  minimizedTitle: ReactNode;
  minimizedMeta?: ReactNode;
  restoreAriaLabel: string;
  minimizeAriaLabel: string;
  headerLeading?: ReactNode;
  minimizeDisabled?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * Shared visual shell for composer-replacing interaction prompts.
 *
 * It intentionally owns only the Ask card chrome and fold/restore behavior.
 * Question navigation, setup state, commands, and persistence stay in their
 * feature components.
 */
export function InteractionPromptCardShell({
  viewerState,
  onViewerStateChange,
  collapsible = true,
  minimizedTitle,
  minimizedMeta,
  restoreAriaLabel,
  minimizeAriaLabel,
  headerLeading,
  minimizeDisabled = false,
  children,
  footer,
  className,
}: InteractionPromptCardShellProps) {
  if (collapsible && viewerState === 'minimized') {
    return (
      <button
        type="button"
        onClick={() => onViewerStateChange('expanded')}
        aria-label={restoreAriaLabel}
        className={cn(
          'w-full rounded-[12px] border',
          'border-[var(--plan-card-border)] bg-[var(--plan-card-bg)]',
          'flex h-[44px] items-center justify-between pl-[20px] pr-[10px]',
          'cursor-pointer text-left transition-colors',
          'hover:bg-[var(--plan-toolbar-btn-hover-bg)]',
        )}
      >
        <div className="flex min-w-0 items-center gap-[12px]">
          <span className="min-w-0 truncate text-14 font-semibold text-[var(--plan-min-title)]">
            {minimizedTitle}
          </span>
          {minimizedMeta ? (
            <span className="shrink-0 text-13 font-normal text-[var(--plan-min-icon)]">
              {minimizedMeta}
            </span>
          ) : null}
        </div>
        <span
          aria-hidden="true"
          className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[6px]"
        >
          <Plus size={16} className="text-[var(--plan-min-icon)]" />
        </span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        'w-full rounded-[12px] border p-[16px]',
        'border-[var(--ask-card-border)] bg-[var(--ask-card-bg)]',
        className,
      )}
    >
      <div className="flex flex-col gap-[12px]">
        <div className="flex h-[28px] items-center justify-between">
          <div className="flex min-w-0 items-center">{headerLeading}</div>
          {collapsible ? (
            <button
              type="button"
              onClick={() => onViewerStateChange('minimized')}
              disabled={minimizeDisabled}
              aria-label={minimizeAriaLabel}
              className={cn(
                'flex h-[28px] w-[28px] shrink-0 cursor-pointer items-center justify-center rounded-[6px]',
                'border border-[var(--confirm-btn-secondary-border)] bg-transparent',
                'text-[var(--confirm-btn-secondary-text)] transition-colors',
                'hover:bg-[var(--confirm-btn-secondary-hover)]',
                minimizeDisabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
              )}
            >
              <Minus size={16} />
            </button>
          ) : null}
        </div>

        <div
          data-testid="interaction-prompt-scroll-region"
          className="min-h-0 max-h-[min(320px,42vh)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        >
          {children}
        </div>
        {footer}
      </div>
    </div>
  );
}
