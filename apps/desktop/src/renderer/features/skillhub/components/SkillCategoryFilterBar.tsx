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

export function SkillCategoryFilterBar({
  categories,
  selectedCategory,
  allLabel,
  ariaLabel,
  onSelectCategory,
  className,
}: SkillCategoryFilterBarProps) {
  return (
    <div
      data-testid="skill-category-filter-scroller"
      onFocusCapture={(event) => {
        event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }}
      className={cn(
        'flex min-w-0 items-center overflow-x-auto overscroll-x-contain [scroll-padding-inline:20%] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      <SegmentedControl
        className="skill-category-tags shrink-0 !max-w-none"
        role="radiogroup"
        aria-label={ariaLabel}
        height={32}
        optionHeight={32}
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
  );
}
