/** Settings → Personalization: global models for short auxiliary text tasks. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { OneshotModelPinPicker, type OneshotPinOption } from '@/cindy-brain/OneshotModelPinPicker';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import type {
  AuxiliaryModelSettingsKey,
  AuxiliaryModelSettingsState,
} from '../../../shared/auxiliaryModelSettings';

const log = createLogger('AuxiliaryModelSection');

export function AuxiliaryModelSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AuxiliaryModelSettingsState | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const modelVisibilityVersion = useModelVisibilityVersion();

  useEffect(() => {
    let disposed = false;
    void window.electronAPI.maker
      .auxiliaryModelSettingsGet()
      .then((next) => {
        if (!disposed) setSettings(next);
      })
      .catch((error) => {
        log.warn('auxiliaryModelSettingsGet failed', error);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const persist = useCallback(
    async (key: AuxiliaryModelSettingsKey, pin: string | null): Promise<void> => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      try {
        const next = await window.electronAPI.maker.auxiliaryModelSettingsSet({ [key]: pin });
        setSettings(next);
      } catch (error) {
        log.warn('auxiliaryModelSettingsSet failed', error);
        toast.error(
          error instanceof Error ? error.message : t('settings.auxiliaryModels.saveFailed'),
        );
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [t],
  );

  const options = useMemo<readonly OneshotPinOption[]>(
    () =>
      (settings?.options ?? []).map((option) => ({
        ...option,
        available:
          option.available !== false
          && isModelEnabled(option.agentKind, option.providerId, {
            id: option.modelId,
            defaultEnabled: option.defaultEnabled,
          }),
      })),
    [modelVisibilityVersion, settings?.options],
  );

  if (!settings) return null;

  const picker = (key: AuxiliaryModelSettingsKey, ariaLabel: string, automaticLabel: string) => (
    <OneshotModelPinPicker
      value={settings[key] ?? undefined}
      defaultLabel=""
      declaredLabel={null}
      options={options}
      onChange={(pin) => {
        void persist(key, pin);
      }}
      ariaLabel={ariaLabel}
      dense
      disabled={pending}
      defaultOptionLabel={automaticLabel}
      searchPlaceholder={t('settings.auxiliaryModels.searchPlaceholder')}
      noResultsLabel={t('settings.auxiliaryModels.noResults')}
      unavailableLabel={t('settings.auxiliaryModels.unavailable')}
      budgetLabel={t('settings.auxiliaryModels.budget')}
      subscriptionLabel={t('settings.auxiliaryModels.subscription')}
    />
  );

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.auxiliaryModels.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.auxiliaryModels.description')}
        </p>
      </div>

      <div className="flex flex-col rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        <div className="flex items-center justify-between gap-4 px-4 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-14 font-medium text-[var(--text-primary)]">
              {t('settings.auxiliaryModels.sessionTitle.label')}
            </div>
            <p className="mt-1 text-12 leading-[1.5] text-[var(--text-tertiary)]">
              {t('settings.auxiliaryModels.sessionTitle.description')}
            </p>
          </div>
          {picker(
            'sessionTitleModel',
            t('settings.auxiliaryModels.sessionTitle.ariaLabel'),
            t('settings.auxiliaryModels.sessionTitle.automatic'),
          )}
        </div>

        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

        <div className="flex items-center justify-between gap-4 px-4 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-14 font-medium text-[var(--text-primary)]">
              {t('settings.auxiliaryModels.promptRecommendation.label')}
            </div>
            <p className="mt-1 text-12 leading-[1.5] text-[var(--text-tertiary)]">
              {t('settings.auxiliaryModels.promptRecommendation.description')}
            </p>
          </div>
          {picker(
            'promptRecommendationModel',
            t('settings.auxiliaryModels.promptRecommendation.ariaLabel'),
            t('settings.auxiliaryModels.promptRecommendation.automatic'),
          )}
        </div>

        <p className="px-4 pb-4 text-12 leading-[1.5] text-[var(--text-secondary)]">
          {t('settings.auxiliaryModels.explicitRouteHint')}
        </p>
      </div>
    </div>
  );
}
