import { useEffect, useLayoutEffect, useRef } from 'react';

import { SegmentedControl } from '@/components/ui/segmented-control';
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

/**
 * Single-line category filters for the SkillHub catalog. The outer capsule is
 * stable while its contents remain horizontally scrollable.
 */
export function SkillCategoryFilterBar({
  categories,
  selectedCategory,
  allLabel,
  ariaLabel,
  onSelectCategory,
  className,
}: SkillCategoryFilterBarProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef({ pointerId: -1, startX: 0, startScroll: 0, moved: false });
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.shiftKey || element.scrollWidth <= element.clientWidth) return;
      const delta = event.deltaX || event.deltaY;
      const previous = element.scrollLeft;
      element.scrollLeft += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1);
      if (element.scrollLeft !== previous) event.preventDefault();
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const selected = element.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!selected) return;
    const target = selected.offsetLeft - (element.clientWidth - selected.offsetWidth) / 2;
    const max = Math.max(0, element.scrollWidth - element.clientWidth);
    element.scrollTo({
      left: Math.max(0, Math.min(target, max)),
      behavior: 'auto',
    });
  }, [categories, selectedCategory]);

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <div
        ref={scrollRef}
        data-testid="skill-category-filter-scroller"
        className="min-w-0 w-max max-w-full flex-initial rounded-full overflow-x-auto overscroll-x-contain select-none [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onPointerDown={(event) => {
          if (event.pointerType !== 'mouse' || event.button !== 0) return;
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startScroll: event.currentTarget.scrollLeft, moved: false };
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (event.pointerId !== state.pointerId) return;
          const delta = event.clientX - state.startX;
          if (!state.moved && Math.abs(delta) < 5) return;
          state.moved = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.scrollLeft = state.startScroll - delta;
          event.preventDefault();
        }}
        onPointerUp={() => { drag.current.pointerId = -1; }}
        onPointerCancel={() => { drag.current.pointerId = -1; }}
        onLostPointerCapture={() => { drag.current.pointerId = -1; }}
        onClickCapture={(event) => {
          if (!drag.current.moved) return;
          event.preventDefault();
          event.stopPropagation();
          drag.current.moved = false;
        }}
      >
        <SegmentedControl
          className="shrink-0 !max-w-none"
          role="radiogroup"
          aria-label={ariaLabel}
          height={32}
          optionHeight={28}
          optionClassName="max-w-40 px-3 text-12"
          value={selectedCategory}
          onValueChange={(value) => {
            if (value !== selectedCategory) onSelectCategory(value);
          }}
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
    </div>
  );
}
