import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Quiet grayscale tag for entries that are new to a menu or list. */
export function NewTag({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    // Owner decision 2026-11-26: "new" keeps the primary text colour it had before Badge.
    <Badge size="xs" className={cn('text-[var(--text-primary)]', className)}>
      {t('sidebar.navigation.new')}
    </Badge>
  );
}
