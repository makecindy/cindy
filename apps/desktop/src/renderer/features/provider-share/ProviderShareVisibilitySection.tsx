import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SETTINGS_HINT,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useOptionalAuthUser } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';
import type { ProviderShareVisibility } from '../../../shared/providerShareInsights';
import {
  providerShareManagementCommand,
  isProviderManagementOutdated,
} from '../provider-group/providerManagement';

/** 两个权限保存在供应商所在电脑；旧端不支持时不退回控制端保存。 */
export function ProviderShareVisibilitySection({
  providerId,
  deviceId,
}: {
  providerId: string;
  deviceId?: string;
}) {
  const { t } = useTranslation();
  const usageDescriptionId = useId();
  useOptionalAuthUser();
  const owner = getDataOwnerGeneration();
  const [view, setView] = useState<ProviderShareVisibility | null>(null);
  const viewOwner = useRef(owner);
  const currentView = isDataOwnerGenerationCurrent(viewOwner.current) ? view : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const sequence = useRef(0);
  const writes = useRef(0);
  useEffect(() => {
    let reading = false;
    const generation = ++sequence.current;
    setView(null);
    const load = async () => {
      if (reading || saving.current || document.visibilityState === 'hidden') return;
      reading = true;
      const write = writes.current;
      try {
        const next = await providerShareManagementCommand(
          { action: 'get-visibility', providerId },
          deviceId,
        );
        if (
          generation !== sequence.current ||
          write !== writes.current ||
          !isDataOwnerGenerationCurrent(owner)
        )
          return;
        viewOwner.current = owner;
        setView(next);
        setError(null);
      } catch (reason) {
        if (
          generation !== sequence.current ||
          write !== writes.current ||
          !isDataOwnerGenerationCurrent(owner)
        )
          return;
        setView(null);
        setError(isProviderManagementOutdated(reason) ? 'needs-update' : 'unavailable');
      } finally {
        reading = false;
      }
    };
    void load();
    const off = window.electronAPI.providerShare.onOwnedChanged(() => {
      void load();
    });
    const timer = window.setInterval(() => {
      void load();
    }, 5_000);
    return () => {
      sequence.current++;
      off();
      window.clearInterval(timer);
    };
  }, [providerId, deviceId, owner]);

  const save = async (key: keyof ProviderShareVisibility, value: boolean) => {
    if (saving.current || !currentView) return;
    saving.current = true;
    writes.current++;
    setBusy(true);
    const generation = sequence.current;
    try {
      const next = await providerShareManagementCommand(
        { action: 'set-visibility', providerId, visibility: { [key]: value } },
        deviceId,
      );
      if (generation === sequence.current && isDataOwnerGenerationCurrent(owner)) {
        viewOwner.current = owner;
        setView(next);
        setError(null);
      }
    } catch (reason) {
      if (generation === sequence.current && isDataOwnerGenerationCurrent(owner)) {
        toast.error(
          t(
            isProviderManagementOutdated(reason)
              ? 'providerShare.insights.needs-update'
              : 'providerShare.insights.saveFailed',
          ),
        );
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      className="mt-6 shrink-0"
      testId="provider-share-visibility"
      headingLevel={3}
      title={t('providerShare.insights.visibilityTitle')}
      description={t('providerShare.insights.visibilityNote')}
    >
      <SettingsCard>
        {(['quota', 'usage'] as const).map((key) => (
          <SettingsRow
            key={key}
            title={t(`providerShare.insights.allow${key === 'quota' ? 'Quota' : 'Usage'}`)}
            hint={
              key === 'usage' ? (
                <span id={usageDescriptionId}>
                  {t('providerShare.insights.allowUsageDescription')}
                </span>
              ) : undefined
            }
            trailing={
              <Switch
                aria-describedby={key === 'usage' ? usageDescriptionId : undefined}
                checked={currentView?.[key] === true}
                disabled={!currentView || busy}
                aria-label={t(`providerShare.insights.allow${key === 'quota' ? 'Quota' : 'Usage'}`)}
                onCheckedChange={(value) => void save(key, value)}
              />
            }
          />
        ))}
      </SettingsCard>
      {error && (
        <p role="status" className={SETTINGS_HINT}>
          {t(`providerShare.insights.${error}`)}
        </p>
      )}
    </SettingsSection>
  );
}
