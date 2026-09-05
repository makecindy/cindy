import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useCustomProviderBillingSettings } from '@/hooks/useCustomProviderBillingSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function CustomProviderBillingSection() {
  const { t } = useTranslation();
  const { showSdkCostForCustomProviders, isCustomized, setShowSdkCostForCustomProviders, reset } =
    useCustomProviderBillingSettings();
  const [saving, setSaving] = useState(false);

  const handleToggle = useCallback(
    (next: boolean) => {
      if (saving) return;
      setSaving(true);
      void setShowSdkCostForCustomProviders(next)
        .catch((err: unknown) => {
          toast.error(
            err instanceof Error ? err.message : t('settings.customProviderBilling.saveFailed'),
          );
        })
        .finally(() => setSaving(false));
    },
    [saving, setShowSdkCostForCustomProviders, t],
  );

  const handleReset = useCallback(() => {
    if (saving) return;
    setSaving(true);
    void reset()
      .then(() => toast.success(t('settings.defaults.restored')))
      .catch(() => toast.error(t('settings.defaults.restoreFailed')))
      .finally(() => setSaving(false));
  }, [reset, saving, t]);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl p-5',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-13 font-medium text-[var(--settings-section-sublabel)]">
            {t('settings.customProviderBilling.title')}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.customProviderBilling.description')}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <DefaultOverrideControls
            isCustomized={isCustomized}
            disabled={saving}
            onReset={handleReset}
          />
          <Switch
            checked={showSdkCostForCustomProviders}
            disabled={saving}
            onCheckedChange={handleToggle}
            aria-label={t('settings.customProviderBilling.toggleAria')}
          />
        </div>
      </div>
    </div>
  );
}
