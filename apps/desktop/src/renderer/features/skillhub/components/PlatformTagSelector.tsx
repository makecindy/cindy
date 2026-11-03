import { ChevronDown } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { MarketCategory } from '../../../../shared/skillhubCategory';

interface PlatformTagSelectorProps {
  categories: readonly MarketCategory[];
  value: readonly string[];
  onChange: (slugs: string[]) => void;
  disabled?: boolean;
  ariaLabel: string;
  placeholder: string;
}

/** Dropdown multi-select over the Platform-managed tags returned by SkillHub. */
export function PlatformTagSelector({
  categories,
  value,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder,
}: PlatformTagSelectorProps) {
  const selected = new Set(value);
  const selectedNames = categories
    .filter((category) => selected.has(category.slug))
    .map((category) => category.name);
  const toggle = (slug: string) => {
    if (disabled) return;
    onChange(selected.has(slug) ? value.filter((item) => item !== slug) : [...value, slug]);
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-full border px-3 text-sm',
            'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
            'border-[var(--settings-input-border)] transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)] focus:border-transparent',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          <span
            className={cn(
              'min-w-0 truncate text-left',
              selectedNames.length === 0 && 'text-[var(--settings-input-placeholder)]',
            )}
          >
            {selectedNames.length > 0 ? selectedNames.join(', ') : placeholder}
          </span>
          <ChevronDown size={14} className="shrink-0 text-[var(--settings-section-desc)]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-testid="platform-tag-options"
        side="bottom"
        align="start"
        onWheel={(event) => {
          // The parent Dialog's scroll lock otherwise cancels wheel input from this portal.
          event.stopPropagation();
        }}
        // Above the publish Dialog; as wide as the trigger; long tag lists scroll.
        className="z-[10010] max-h-52 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto overscroll-contain"
      >
        {categories.map((category) => (
          <DropdownMenuCheckboxItem
            key={category.slug}
            checked={selected.has(category.slug)}
            onCheckedChange={() => toggle(category.slug)}
            // Multi-select: keep the menu open while ticking several tags.
            onSelect={(event) => event.preventDefault()}
          >
            <span className="min-w-0 truncate">{category.name}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
