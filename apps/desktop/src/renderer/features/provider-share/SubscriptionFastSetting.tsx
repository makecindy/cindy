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

/** Provider/account control, intentionally absent for custom API connections and older hosts. */
export function SubscriptionFastSetting({
  provider,
  deviceId,
}: {
  provider: ProviderView;
  deviceId?: string;
}) {
  const { t } = useTranslation();
  const [allowed, setAllowed] = useState(provider.subscriptionFastPolicy?.allowFast !== false);
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
    // A committed catalog push can precede a native-update failure. Refresh the
    // value without invalidating that same provider's pending save feedback.
    setAllowed(provider.subscriptionFastPolicy?.allowFast !== false);
  }, [provider.id, deviceId, provider.subscriptionFastPolicy?.allowFast]);
  if (!provider.subscriptionFastPolicy) return null;
  const change = async (allowFast: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    const owner = getDataOwnerGeneration();
    const request = sequence.current;
    try {
      const next = await providerShareManagementCommand(
        { action: 'set-fast-policy', providerId: provider.id, allowFast },
        deviceId,
      );
      if (alive.current && request === sequence.current && isDataOwnerGenerationCurrent(owner))
        setAllowed(next.allowFast);
    } catch {
      if (alive.current && request === sequence.current && isDataOwnerGenerationCurrent(owner))
        toast.error(t('subscriptionFastPolicy.saveFailed'));
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className={SETTINGS_CARD_CLASS}>
      <div className={SETTINGS_ROW_CLASS}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className={SETTINGS_ROW_LABEL_CLASS}>{t('subscriptionFastPolicy.label')}</span>
          <span className={SETTINGS_ROW_HINT_CLASS}>
            {t('subscriptionFastPolicy.providerHint')}
          </span>
        </div>
        <Switch
          checked={allowed}
          disabled={busy}
          aria-label={t('subscriptionFastPolicy.label')}
          onCheckedChange={(value) => void change(value)}
        />
      </div>
    </div>
  );
}
