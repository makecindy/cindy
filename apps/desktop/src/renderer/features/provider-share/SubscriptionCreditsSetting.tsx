import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderView } from '@cindy/model-providers';
import { Switch } from '@/components/ui/switch';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
} from '@/components/settings/settingsRowClasses';
import { providerShareManagementCommand } from '../provider-group/providerManagement';

/** Provider/account control for spending purchased credits after the included limit. */
export function SubscriptionCreditsSetting({
  provider,
  deviceId,
}: {
  provider: ProviderView;
  deviceId?: string;
}) {
  const { t } = useTranslation();
  const [autoUseCredits, setAutoUseCredits] = useState(
    provider.subscriptionCreditsPolicy?.autoUseCredits !== false,
  );
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const sequence = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    sequence.current++;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, [provider.id, deviceId]);

  useEffect(() => {
    setAutoUseCredits(provider.subscriptionCreditsPolicy?.autoUseCredits !== false);
  }, [provider.id, deviceId, provider.subscriptionCreditsPolicy?.autoUseCredits]);

  if (!provider.subscriptionCreditsPolicy) return null;

  const change = async (nextValue: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    const owner = getDataOwnerGeneration();
    const request = sequence.current;
    try {
      const next = await providerShareManagementCommand(
        { action: 'set-credits-policy', providerId: provider.id, autoUseCredits: nextValue },
        deviceId,
      );
      if (alive.current && request === sequence.current && isDataOwnerGenerationCurrent(owner))
        setAutoUseCredits(next.autoUseCredits);
    } catch {
      if (alive.current && request === sequence.current && isDataOwnerGenerationCurrent(owner))
        toast.error(t('subscriptionCreditsPolicy.saveFailed'));
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className={SETTINGS_CARD_CLASS}>
      <div className={SETTINGS_ROW_CLASS}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className={SETTINGS_ROW_LABEL_CLASS}>{t('subscriptionCreditsPolicy.label')}</span>
          <span className={SETTINGS_ROW_HINT_CLASS}>
            {t('subscriptionCreditsPolicy.providerHint')}
          </span>
        </div>
        <Switch
          checked={autoUseCredits}
          disabled={busy}
          aria-label={t('subscriptionCreditsPolicy.label')}
          onCheckedChange={(value) => void change(value)}
        />
      </div>
    </div>
  );
}
