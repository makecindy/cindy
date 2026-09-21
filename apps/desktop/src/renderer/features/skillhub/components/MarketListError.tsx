import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function MarketListError({ error, loading, onRetry }: { error: string | null; loading: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  if (!error) return null;
  return <div role="alert" className="flex flex-wrap items-center gap-3 p-4">
    <p className="text-sm text-[var(--error-fg)]">{t('skillhub.market.loadFailed', { error })}</p>
    <Button variant="secondary" disabled={loading} onClick={onRetry}>{t('skillhub.unifiedDetail.retry')}</Button>
  </div>;
}
