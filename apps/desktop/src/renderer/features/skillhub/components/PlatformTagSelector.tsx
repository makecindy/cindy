import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { MarketCategory } from '../../../../shared/skillhubCategory';

interface PlatformTagSelectorProps {
  categories: readonly MarketCategory[];
  value: readonly string[];
  onChange: (slugs: string[]) => void;
  disabled?: boolean;
  ariaLabel: string;
}

/** Multi-select over the Platform-managed tags returned by SkillHub. */
export function PlatformTagSelector({
  categories,
  value,
  onChange,
  disabled = false,
  ariaLabel,
}: PlatformTagSelectorProps) {
  const selected = new Set(value);
  const toggle = (slug: string) => {
    if (disabled) return;
    onChange(selected.has(slug) ? value.filter((item) => item !== slug) : [...value, slug]);
  };

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] p-2"
    >
      {categories.map((category) => {
        const checked = selected.has(category.slug);
        return (
          <button
            key={category.slug}
            type="button"
            aria-pressed={checked}
            disabled={disabled}
            onClick={() => toggle(category.slug)}
            className={cn(
              'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-3 text-12 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              checked
                ? 'border-[var(--text-primary)] bg-[var(--surface-chip)] text-[var(--text-primary)]'
                : 'border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)]',
            )}
          >
            {checked ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : null}
            <span className="truncate">{category.name}</span>
          </button>
        );
      })}
    </div>
  );
}
