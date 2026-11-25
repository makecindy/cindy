import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';

/** Quiet grayscale tag for entries that are new to a menu or list. */
export function NewTag({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge size="xs" className={className}>
      {t('sidebar.navigation.new')}
    </Badge>
  );
}
