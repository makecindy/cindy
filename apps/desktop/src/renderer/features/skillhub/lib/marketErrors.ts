import { i18n } from '@/i18n';
import type { TFunction } from 'i18next';

export type MarketActionErrorKey =
  | 'skillhub.marketErrors.forbidden'
  | 'skillhub.marketErrors.notFound'
  | 'skillhub.marketErrors.managementApiUnavailable'
  | 'skillhub.marketErrors.invalidVisibility'
  | 'skillhub.marketErrors.default';

export function marketActionErrorKey(error?: string, errorCode?: string): MarketActionErrorKey | null {
  const raw = `${errorCode ?? ''} ${error ?? ''}`.toLowerCase();
  if (errorCode === 'INVALID_VISIBILITY') return 'skillhub.marketErrors.invalidVisibility';
  if (raw.includes('403') || raw.includes('forbidden')) return 'skillhub.marketErrors.forbidden';
  if (!raw.includes('hub_404') && (raw.includes('404') || raw.includes('not found'))) return 'skillhub.marketErrors.notFound';
  if (
    raw.includes('hub_404') ||
    raw.includes('patch /api/s2s') ||
    raw.includes('delete /api/s2s') ||
    raw.includes('set-visibility') ||
    raw.includes('unpublish')
  ) {
    return 'skillhub.marketErrors.managementApiUnavailable';
  }
  if (error?.trim()) return null;
  return 'skillhub.marketErrors.default';
}

export function marketActionErrorMessage(error: string | undefined, errorCode: string | undefined, t: TFunction = i18n.t.bind(i18n)): string {
  const key = marketActionErrorKey(error, errorCode);
  if (key) return t(key);
  if (error?.trim()) return error.trim();
  return t('skillhub.marketErrors.default');
}
