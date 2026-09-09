import * as Popover from '@radix-ui/react-popover';
import { ChevronDown } from 'lucide-react';

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
    <Popover.Root>
      <Popover.Trigger asChild>
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
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-testid="platform-tag-options"
          side="bottom"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onWheel={(event) => {
            // The parent Dialog's scroll lock otherwise cancels wheel input from this portal.
            event.stopPropagation();
          }}
          className={cn(
            'z-[10010] max-h-52 w-[var(--radix-popover-trigger-width)] overflow-y-auto overscroll-contain rounded-xl border p-1',
            'border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
            '[box-shadow:var(--cmd-palette-shadow)]',
          )}
        >
          {categories.map((category) => (
            <label
              key={category.slug}
              className={cn(
                'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm',
                'text-[var(--msg-assistant-text)] transition-colors hover:bg-[var(--surface-hover)]',
              )}
            >
              <input
                type="checkbox"
                checked={selected.has(category.slug)}
                onChange={() => toggle(category.slug)}
                className="size-3.5 cursor-pointer accent-[var(--confirm-btn-primary-bg)]"
              />
              <span className="min-w-0 truncate">{category.name}</span>
            </label>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
