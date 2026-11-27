import { BadgeCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';

export function OfficialSkillBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge
      className={className}
      title={t('skillhub.builtIn.officialDetail')}
      icon={<BadgeCheck size={12} strokeWidth={2} className="text-[var(--accent-emphasis)]" />}
    >
      {t('skillhub.builtIn.official')}
    </Badge>
  );
}
