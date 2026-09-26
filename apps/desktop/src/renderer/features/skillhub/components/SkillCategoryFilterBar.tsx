import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Tip } from '@/components/ui/tooltip';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/utils';
import { CATEGORY_ALL, type MarketCategory } from '../../../../shared/skillhubCategory';
import type { CategoryFilter } from '../hooks/useMarketList';

interface SkillCategoryFilterBarProps {
  categories: readonly MarketCategory[];
  selectedCategory: CategoryFilter;
  allLabel: string;
  ariaLabel: string;
  scrollLeftLabel: string;
  scrollRightLabel: string;
  scrollStartLabel: string;
  scrollEndLabel: string;
  onSelectCategory: (category: CategoryFilter) => void;
  className?: string;
}

interface ScrollState {
  overflow: boolean;
  left: boolean;
  right: boolean;
}

const INITIAL_SCROLL_STATE: ScrollState = {
  overflow: false,
  left: false,
  right: false,
};

export function skillCategoryScrollStep(clientWidth: number): number {
  return Math.max(120, Math.floor(clientWidth * 0.7));
}

/**
 * Single-line category filters for the SkillHub catalog. Arrow controls stay
 * outside the scroll viewport so every category remains a full click target.
 */
export function SkillCategoryFilterBar({
  categories,
  selectedCategory,
  allLabel,
  ariaLabel,
  scrollLeftLabel,
  scrollRightLabel,
  scrollStartLabel,
  scrollEndLabel,
  onSelectCategory,
  className,
}: SkillCategoryFilterBarProps) {
  const reducedMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollState, setScrollState] = useState<ScrollState>(INITIAL_SCROLL_STATE);

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    const next: ScrollState = {
      overflow: maxScrollLeft > 1,
      left: element.scrollLeft > 1,
      right: element.scrollLeft < maxScrollLeft - 1,
    };
    setScrollState((previous) =>
      previous.overflow === next.overflow &&
      previous.left === next.left &&
      previous.right === next.right
        ? previous
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    updateScrollState();
    const element = scrollRef.current;
    if (!element) return undefined;
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollState);
    resizeObserver?.observe(element);
    window.addEventListener('resize', updateScrollState);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateScrollState);
    };
  }, [updateScrollState]);

  useEffect(() => {
    updateScrollState();
  }, [categories, updateScrollState]);

  const scroll = (direction: -1 | 1) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollBy({
      left: direction * skillCategoryScrollStep(element.clientWidth),
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  };

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {scrollState.overflow ? (
        <Tip text={scrollState.left ? scrollLeftLabel : scrollStartLabel} side="bottom">
          <span className="inline-flex shrink-0">
            <button
              type="button"
              aria-label={scrollState.left ? scrollLeftLabel : scrollStartLabel}
              disabled={!scrollState.left}
              onClick={() => scroll(-1)}
              className={cn(
                'inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)]',
                'bg-[var(--surface-elevated)] text-[var(--text-secondary)] transition-colors duration-150',
                'hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                'disabled:cursor-default disabled:opacity-35',
              )}
            >
              <ChevronLeft size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </span>
        </Tip>
      ) : null}

      <div
        ref={scrollRef}
        data-testid="skill-category-filter-scroller"
        onScroll={updateScrollState}
        className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <SegmentedControl
          className="shrink-0 !max-w-none"
          role="radiogroup"
          aria-label={ariaLabel}
          height={32}
          optionHeight={28}
          optionClassName="max-w-40 px-3 text-12"
          value={selectedCategory}
          onValueChange={onSelectCategory}
          options={[
            { value: CATEGORY_ALL, label: <span className="truncate">{allLabel}</span>, title: allLabel },
            ...categories.map((category) => ({
              value: category.slug as CategoryFilter,
              label: <span className="truncate">{category.name}</span>,
              title: category.name,
            })),
          ]}
        />
      </div>

      {scrollState.overflow ? (
        <Tip text={scrollState.right ? scrollRightLabel : scrollEndLabel} side="bottom">
          <span className="inline-flex shrink-0">
            <button
              type="button"
              aria-label={scrollState.right ? scrollRightLabel : scrollEndLabel}
              disabled={!scrollState.right}
              onClick={() => scroll(1)}
              className={cn(
                'inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--border-default)]',
                'bg-[var(--surface-elevated)] text-[var(--text-secondary)] transition-colors duration-150',
                'hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                'disabled:cursor-default disabled:opacity-35',
              )}
            >
              <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </span>
        </Tip>
      ) : null}
    </div>
  );
}
