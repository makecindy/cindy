import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/** Quiet grayscale tag for entries that are new to a menu or list. */
export function NewTag({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-px text-10 font-medium leading-4 text-[var(--text-primary)]',
        className,
      )}
    >
      {t('sidebar.navigation.new')}
    </span>
  );
}
