import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    <section className="mt-6 shrink-0" data-testid="provider-share-visibility">
      <h3 className="text-13 font-medium leading-[1.5] text-[var(--settings-section-title)]">
        {t('providerShare.insights.visibilityTitle')}
      </h3>
      <p className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]">
        {t('providerShare.insights.visibilityNote')}
      </p>
      <div className="mt-3 divide-y divide-[var(--border-default)] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4">
        {(['quota', 'usage'] as const).map((key) => (
          <div key={key} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-13 leading-[1.5] text-[var(--text-primary)]">
                {t(`providerShare.insights.allow${key === 'quota' ? 'Quota' : 'Usage'}`)}
              </p>
              {key === 'usage' && (
                <p
                  id={usageDescriptionId}
                  className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]"
                >
                  {t('providerShare.insights.allowUsageDescription')}
                </p>
              )}
            </div>
            <Switch
              aria-describedby={key === 'usage' ? usageDescriptionId : undefined}
              checked={currentView?.[key] === true}
              disabled={!currentView || busy}
              aria-label={t(`providerShare.insights.allow${key === 'quota' ? 'Quota' : 'Usage'}`)}
              onCheckedChange={(value) => void save(key, value)}
            />
          </div>
        ))}
      </div>
      {error && (
        <p role="status" className="mt-2 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t(`providerShare.insights.${error}`)}
        </p>
      )}
    </section>
  );
}
