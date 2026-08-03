import { forwardRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

interface SessionSearchBarProps {
  query: string;
  total: number;
  activeIndex: number;
  searching: boolean;
  onChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

/** Search controls scoped to the current conversation's message content. */
export const SessionSearchBar = forwardRef<HTMLInputElement, SessionSearchBarProps>(
  function SessionSearchBar(
    { query, total, activeIndex, searching, onChange, onNext, onPrevious, onClose },
    ref,
  ) {
    const { t } = useTranslation();
    return (
      <div
        className={cn(
          'absolute right-4 top-2 z-40 flex w-[300px] items-center gap-1',
          'rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg',
          'origin-top-right animate-float-in',
        )}
        role="search"
        aria-label={t('findInPage.dialogAriaLabel')}
        data-session-search-bar=""
      >
        <input
          ref={ref}
          type="text"
          value={query}
          placeholder={t('findInPage.placeholder')}
          aria-label={t('findInPage.placeholder')}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              if (event.shiftKey) onPrevious();
              else onNext();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <span className="select-none whitespace-nowrap px-1 text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {query ? (searching ? '…' : total > 0 ? `${activeIndex + 1}/${total}` : '0/0') : ''}
        </span>
        <button
          type="button"
          aria-label={t('findInPage.previous')}
          disabled={!query || total === 0}
          onClick={onPrevious}
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-titlebar-button-hover disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          aria-label={t('findInPage.next')}
          disabled={!query || total === 0}
          onClick={onNext}
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-titlebar-button-hover disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none"
        >
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          aria-label={t('findInPage.close')}
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-titlebar-button-hover focus-visible:outline-none"
        >
          <X size={14} />
        </button>
      </div>
    );
  },
);
