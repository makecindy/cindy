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

/** Provider/account control for the Ultra reasoning tier. Default on. */
export function SubscriptionUltraSetting({
  provider,
  deviceId,
}: {
  provider: ProviderView;
  deviceId?: string;
}) {
  const { t } = useTranslation();
  const [allowUltra, setAllowUltra] = useState(
    provider.subscriptionUltraPolicy?.allowUltra !== false,
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
    setAllowUltra(provider.subscriptionUltraPolicy?.allowUltra !== false);
  }, [provider.id, deviceId, provider.subscriptionUltraPolicy?.allowUltra]);

  if (!provider.subscriptionUltraPolicy) return null;

  const change = async (nextValue: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    const owner = getDataOwnerGeneration();
    const request = sequence.current;
    try {
      const next = await providerShareManagementCommand(
        { action: 'set-ultra-policy', providerId: provider.id, allowUltra: nextValue },
        deviceId,
      );
      if (alive.current && request === sequence.current && isDataOwnerGenerationCurrent(owner))
        setAllowUltra(next.allowUltra);
    } catch {
      if (alive.current && request === sequence.current && isDataOwnerGenerationCurrent(owner))
        toast.error(t('subscriptionUltraPolicy.saveFailed'));
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className={SETTINGS_CARD_CLASS}>
      <div className={SETTINGS_ROW_CLASS}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className={SETTINGS_ROW_LABEL_CLASS}>{t('subscriptionUltraPolicy.label')}</span>
          <span className={SETTINGS_ROW_HINT_CLASS}>
            {t('subscriptionUltraPolicy.providerHint')}
          </span>
        </div>
        <Switch
          checked={allowUltra}
          disabled={busy}
          aria-label={t('subscriptionUltraPolicy.label')}
          onCheckedChange={(value) => void change(value)}
        />
      </div>
    </div>
  );
}
