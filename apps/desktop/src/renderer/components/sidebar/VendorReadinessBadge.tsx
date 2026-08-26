/**
 * VendorReadinessBadge — M33: vendor 就绪状态 emoji badge（F7-mini）
 */

import type { Readiness } from '@/hooks/useVendorReadiness';
import { useTranslation } from 'react-i18next';

const BADGE_MAP: Record<Exclude<Readiness, 'loading'>, string> = {
  ready: '🟢',
  unauthenticated: '🟡',
  'binary-missing': '🔴',
};

interface VendorReadinessBadgeProps {
  readiness: Readiness;
}

export function VendorReadinessBadge({ readiness }: VendorReadinessBadgeProps) {
  const { t } = useTranslation();
  if (readiness === 'loading') {
    return (
      <span className="text-10 text-muted-foreground" aria-label={t('sidebar.vendorReadiness.loading')}>
        ●
      </span>
    );
  }
  return (
    <span aria-label={t(`sidebar.vendorReadiness.${readiness}`)}>{BADGE_MAP[readiness]}</span>
  );
}
