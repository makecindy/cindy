import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { LocalCatalogFailure, LocalCatalogFailureReason } from '@/lib/localCatalogLoadState';

const MESSAGE_KEYS: Record<LocalCatalogFailureReason, string> = {
  'owner-pending': 'settings.providers.catalogRecovery.pending',
  'profile-pending': 'settings.providers.catalogRecovery.pending',
  'legacy-owner-unavailable': 'settings.providers.catalogRecovery.legacy',
  'legacy-busy': 'settings.providers.catalogRecovery.legacy',
  'preferences-corrupt': 'settings.providers.catalogRecovery.corrupt',
  'storage-quota': 'settings.providers.catalogRecovery.quota',
  'storage-unavailable': 'settings.providers.catalogRecovery.storage',
  'lock-unavailable': 'settings.providers.catalogRecovery.storage',
  'preferences-unavailable': 'settings.providers.catalogRecovery.pending',
  'catalog-unavailable': 'settings.providers.catalogRecovery.catalog',
};

/** One recovery message for local pickers and provider settings; remote state stays separate. */
export function LocalModelCatalogNotice({
  failure,
  onRetry,
}: {
  failure: LocalCatalogFailure;
  onRetry: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  return (
    <div
      role="status"
      className="flex shrink-0 flex-col items-start gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3 text-13 leading-[1.5] text-[var(--text-secondary)]"
    >
      <p>{t(MESSAGE_KEYS[failure.reason])}</p>
      <Button
        variant="secondary"
        loading={retrying}
        onClick={() => {
          setRetrying(true);
          // The catalog coordinator owns error reporting and retains the valid snapshot.
          void onRetry().catch(() => undefined).finally(() => setRetrying(false));
        }}
      >
        {t('settings.providers.catalogRecovery.retry')}
      </Button>
    </div>
  );
}
