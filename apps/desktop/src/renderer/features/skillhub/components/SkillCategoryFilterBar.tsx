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
  onSelectCategory: (category: CategoryFilter) => void;
  className?: string;
}

/**
 * Single-line category filters using the shared catalog navigation styling.
 * Overflow stays horizontally scrollable with the selected category visible.
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
    const onRelease = (event: PointerEvent) => {
      if (event.pointerId !== drag.current.pointerId) return;
      drag.current.pointerId = -1;
      if (event.type === 'pointercancel') drag.current.moved = false;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    // Capture begins only after a horizontal drag, so ordinary option clicks keep
    // their original target. A release outside the bar must still end the gesture.
    window.addEventListener('pointerup', onRelease, true);
    window.addEventListener('pointercancel', onRelease, true);
    return () => {
      element.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointerup', onRelease, true);
      window.removeEventListener('pointercancel', onRelease, true);
    };
  }, []);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const centerSelected = () => {
      const selected = element.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!selected) return;
      const target = selected.offsetLeft - (element.clientWidth - selected.offsetWidth) / 2;
      const max = Math.max(0, element.scrollWidth - element.clientWidth);
      element.scrollTo({ left: Math.max(0, Math.min(target, max)), behavior: 'auto' });
    };
    centerSelected();
    if (typeof ResizeObserver === 'undefined') return;
    let active = true;
    let previousWidth = element.clientWidth;
    let previousContentWidth = element.scrollWidth;
    const observer = new ResizeObserver(() => {
      if (!active || (element.clientWidth === previousWidth && element.scrollWidth === previousContentWidth)) return;
      previousWidth = element.clientWidth;
      previousContentWidth = element.scrollWidth;
      centerSelected();
    });
    observer.observe(element);
    // Font loading can resize the option row without changing the outer capsule.
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [categories, selectedCategory]);

  return (
    <div className={cn('flex min-w-0 items-center', className)}>
      <div className="min-w-0 max-w-full overflow-hidden">
        <div
          ref={scrollRef}
          data-testid="skill-category-filter-scroller"
          onFocusCapture={(event) => {
            event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }}
          className="min-w-0 w-max max-w-full flex-initial overflow-x-auto overscroll-x-contain select-none [scroll-padding-inline:20%] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onPointerDown={(event) => {
            if (event.pointerType !== 'mouse' || event.button !== 0) return;
            drag.current = { pointerId: event.pointerId, startX: event.clientX, startScroll: event.currentTarget.scrollLeft, moved: false };
          }}
          onPointerMove={(event) => {
            const state = drag.current;
            if (event.pointerId !== state.pointerId) return;
            if ((event.buttons & 1) === 0) {
              state.pointerId = -1;
              state.moved = false;
              return;
            }
            const delta = event.clientX - state.startX;
            if (!state.moved && Math.abs(delta) < 5) return;
            state.moved = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.scrollLeft = state.startScroll - delta;
            event.preventDefault();
          }}
          onPointerUp={() => { drag.current.pointerId = -1; }}
          onPointerCancel={() => { drag.current.pointerId = -1; drag.current.moved = false; }}
          onLostPointerCapture={() => { drag.current.pointerId = -1; }}
          onClickCapture={(event) => {
            if (!drag.current.moved) return;
            event.preventDefault();
            event.stopPropagation();
            drag.current.moved = false;
          }}
        >
          <SegmentedControl
            className="skill-category-tags shrink-0 !max-w-none"
            role="radiogroup"
            aria-label={ariaLabel}
            height={32}
            optionHeight={32}
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
    </div>
  );
}
