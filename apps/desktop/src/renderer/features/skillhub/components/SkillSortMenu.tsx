import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';

export type SkillHomeSort = 'downloads' | 'updated_at';

export function SkillSortMenu({ value, onChange }: { value: SkillHomeSort; onChange: (value: SkillHomeSort) => void }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
          {t(value === 'downloads' ? 'skillhub.home.sortDownloads' : 'skillhub.home.sortUpdated')}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => { if (next === 'downloads' || next === 'updated_at') onChange(next); }}>
          <DropdownMenuRadioItem value="downloads">{t('skillhub.home.sortDownloads')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="updated_at">{t('skillhub.home.sortUpdated')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
