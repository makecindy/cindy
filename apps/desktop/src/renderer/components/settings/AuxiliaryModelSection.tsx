import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { useAppSettingsRevision } from '@/hooks/useAppSettingsRevision';
/** Settings → Personalization: one ordered chain for short auxiliary text. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { SETTINGS_HINT, SettingsBlock, SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';

import { OneshotModelPinPicker } from '@/cindy-brain/OneshotModelPinPicker';
import { useAuth } from '@/contexts/AuthContext';
import { useProviders } from '@/hooks/useProviders';
import { createLogger } from '@/lib/logger';
import { providerDisplayName } from '@/lib/providerDisplayName';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import {
  AUTO_AUXILIARY_MODEL_CHAIN,
  AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS,
} from '../../../shared/auxiliaryModelChain';
import type { AuxiliaryModelSettingsState } from '../../../shared/auxiliaryModelSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const log = createLogger('AuxiliaryModelSection');

const SLOT_I18N = ['preferred', 'fallback1', 'fallback2'] as const;
type AuxiliaryModelMode = 'automatic' | 'custom';

export function AuxiliaryModelSection() {
  const settingsRevision = useAppSettingsRevision('auxiliary-models');
  const { t } = useTranslation();
  const { mode: authMode } = useAuth();
  const { providers } = useProviders();
  const cindyAiProvider = providers.find((provider) => provider.id === 'xd');
  const cindyAiName = cindyAiProvider ? providerDisplayName(cindyAiProvider, t) : null;
  const [settings, setSettings] = useState<AuxiliaryModelSettingsState | null>(null);
  const [pending, setPending] = useState(false);
  const [drafting, setDrafting] = useState(false);
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
  }, [settingsRevision]);

  const persistModels = useCallback(
    async (models: string[]): Promise<boolean> => {
      if (pendingRef.current) return false;
      pendingRef.current = true;
      setPending(true);
      try {
        const next = await window.electronAPI.maker.auxiliaryModelSettingsSet({ models });
        setSettings(next);
        if (models.length === 0) setDrafting(false);
        return true;
      } catch (error) {
        log.warn('auxiliaryModelSettingsSet failed', error);
        toast.error(
          error instanceof Error ? error.message : t('settings.auxiliaryModels.saveFailed'),
        );
        return false;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [t],
  );

  const options = useMemo(
    () =>
      (settings?.options ?? []).map((option) => ({
        ...option,
        // Names follow the existing live catalog, independently of saved choices
        // or an in-flight save whose options may still carry the old locale.
        ...(option.providerId === 'xd' && cindyAiName ? {
          group: cindyAiName,
          logoKind: cindyAiProvider?.logoKind,
          label: `${option.agentSuffix} · ${option.modelName} · ${cindyAiName}`,
        } : {}),
        available:
          option.available !== false &&
          isModelEnabled(option.agentKind, option.providerId, {
            id: option.modelId,
            defaultEnabled: option.defaultEnabled,
          }),
      })),
    [cindyAiName, cindyAiProvider?.logoKind, modelVisibilityVersion, settings?.options],
  );

  if (!settings) return null;

  const models = Array.isArray(settings.models) ? settings.models : [];
  const customized = models.length > 0;
  const showCustom = customized || drafting;
  // Keep the default/override split intact: first-time Custom is only a draft.
  // Local and signed-out sessions cannot use Cindy AI routes, so do not seed
  // those unavailable catalog pins into a draft that the user cannot select.
  const automaticDraftModels =
    authMode === 'cloud'
      ? AUTO_AUXILIARY_MODEL_CHAIN.filter((ref) =>
          options.some((option) => option.id === ref && option.available),
        )
      : [];
  const activeModels = customized ? models : drafting ? automaticDraftModels : [];
  const automaticChain = AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS.map((key) =>
    t(`settings.auxiliaryModels.chain.${key}`),
  ).join(' → ');
  const mode: AuxiliaryModelMode = showCustom ? 'custom' : 'automatic';

  const selectMode = (nextMode: AuxiliaryModelMode): void => {
    if (nextMode === 'custom') {
      setDrafting(true);
      return;
    }
    if (!customized) {
      setDrafting(false);
      return;
    }
    void persistModels([]);
  };

  const applySlot = (index: number, pin: string | null): void | boolean | Promise<boolean> => {
    if (index === 0 && !pin) {
      if (customized) {
        return persistModels([]);
      } else {
        setDrafting(false);
      }
      return;
    }
    const slots = [...activeModels];
    if (!pin) {
      slots.splice(index, 1);
    } else if (index >= slots.length) {
      slots.push(pin);
    } else {
      if (slots.some((entry, slotIndex) => slotIndex !== index && entry === pin)) return false;
      slots[index] = pin;
    }
    const unique: string[] = [];
    for (const entry of slots) {
      if (entry && !unique.includes(entry)) unique.push(entry);
    }
    return persistModels(unique);
  };

  return (
    <SettingsSection
      title={t(personalizationDetailsSettings.auxiliaryModelsTitle.titleKey)}
      description={t(personalizationDetailsSettings.auxiliaryModelsTitle.descriptionKey)}
    >
      <SettingsCard>
        <SettingsRow
          title={t(personalizationDetailsSettings.auxiliaryModelsTitle.titleKey)}
          trailing={
            <div className="flex min-w-0 max-w-full items-center justify-end gap-2">
              {showCustom ? (
                <DefaultOverrideControls
                  isCustomized={customized || drafting}
                  showCustomizedBadge={customized}
                  disabled={pending}
                  onReset={() => {
                    if (!customized) {
                      setDrafting(false);
                      return;
                    }
                    void persistModels([]);
                  }}
                />
              ) : null}
              <Select data-setting-id={personalizationDetailsSettings.auxiliaryModelsTitle.id}
                label={t(personalizationDetailsSettings.auxiliaryModelsTitle.titleKey)}
                value={mode}
                options={(['automatic', 'custom'] as const).map((option) => ({
                  value: option,
                  label: t(
                    option === 'automatic'
                      ? 'settings.auxiliaryModels.automatic'
                      : 'settings.auxiliaryModels.customize',
                  ),
                }))}
                onValueChange={(value) => selectMode(value as AuxiliaryModelMode)}
                disabled={pending}
                width="sm"
                className="shrink"
              />
            </div>
          }
        />

        {showCustom ? (
          <>
            {SLOT_I18N.map((slotKey, index) => {
              const definition = slotKey === 'preferred' ? personalizationDetailsSettings.auxiliaryModelsPreferredLabel : slotKey === 'fallback1' ? personalizationDetailsSettings.auxiliaryModelsFallback1Label : personalizationDetailsSettings.auxiliaryModelsFallback2Label;
              const pin = activeModels[index];
              const selectedByOtherSlot = new Set(
                activeModels.filter((entry, slotIndex) => slotIndex !== index && entry),
              );
              const slotOptions = options.filter(
                (option) => option.id === pin || !selectedByOtherSlot.has(option.id),
              );
              return (
                <SettingsRow
                  key={slotKey}
                  title={t(definition.titleKey)}
                  hint={t(`settings.auxiliaryModels.${slotKey}.description`)}
                  trailing={
                    <div className="w-[min(100%,320px)] shrink-0">
                      {/* One-shot pins already carry the exact provider + agent route. The
                          provider-first picker exposes every routable supplier without
                          surfacing Harness or a thinking-depth control. */}
                      <OneshotModelPinPicker
                        data-setting-id={definition.id}
                        value={pin ?? undefined}
                        options={slotOptions}
                        onChange={(next) => applySlot(index, next)}
                        ariaLabel={t(`settings.auxiliaryModels.${slotKey}.ariaLabel`)}
                        dense
                        defaultOptionLabel={t('settings.auxiliaryModels.emptySlot')}
                        searchPlaceholder={t('settings.auxiliaryModels.searchPlaceholder')}
                        noResultsLabel={t('settings.auxiliaryModels.noResults')}
                        unavailableLabel={t('settings.auxiliaryModels.unavailable')}
                        budgetLabel={t('settings.auxiliaryModels.budget')}
                        subscriptionLabel={t('settings.auxiliaryModels.subscription')}
                        groupByProvider
                        disabled={pending || (index > 0 && !activeModels[index - 1])}
                      />
                    </div>
                  }
                />
              );
            })}

            <p className={cn('px-4 pb-4', SETTINGS_HINT)}>
              {authMode !== 'cloud' ? (
                <span className="mb-1 block text-[var(--text-tertiary)]">
                  {t('settings.auxiliaryModels.signInHint')}
                </span>
              ) : null}
              {t('settings.auxiliaryModels.customHint')}
            </p>
          </>
        ) : (
          <SettingsBlock>
            <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">
              {automaticChain}
            </p>
            {authMode !== 'cloud' ? (
              <p className="mt-1 text-12 leading-[1.5] text-[var(--text-tertiary)]">
                {t('settings.auxiliaryModels.signInHint')}
              </p>
            ) : null}
          </SettingsBlock>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
