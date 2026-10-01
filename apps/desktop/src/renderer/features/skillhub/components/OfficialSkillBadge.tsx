import { BadgeCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export function OfficialSkillBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2',
        'text-11 font-medium leading-none text-[var(--text-primary)]',
        className,
      )}
      title={t('skillhub.builtIn.officialDetail')}
    >
      <BadgeCheck size={12} strokeWidth={2} className="text-[var(--accent-emphasis)]" aria-hidden="true" />
      {t('skillhub.builtIn.official')}
    </span>
  );
}
