/**
 * VendorReadinessBadge — M33: vendor 就绪状态 emoji badge（F7-mini）
 */

import type { Readiness } from '@/hooks/useVendorReadiness';

const BADGE_MAP: Record<Exclude<Readiness, 'loading'>, string> = {
  ready: '🟢',
  unauthenticated: '🟡',
  'binary-missing': '🔴',
};

interface VendorReadinessBadgeProps {
  readiness: Readiness;
}

export function VendorReadinessBadge({ readiness }: VendorReadinessBadgeProps) {
  if (readiness === 'loading') {
    return <span className="text-10 text-muted-foreground" aria-label="loading">●</span>;
  }
  return <span aria-label={readiness}>{BADGE_MAP[readiness]}</span>;
}
