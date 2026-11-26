import { AuxiliaryErrorDetail, auxiliaryErrorSummary } from './AuxiliaryErrorDetail';
import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { useAppSettingsRevision } from '@/hooks/useAppSettingsRevision';
/** Settings → Personalization: one ordered chain for short auxiliary text. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Button } from '@/components/ui/button';
import { SETTINGS_HINT, SettingsBlock, SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';

import { OneshotModelPinPicker } from '@/cindy-brain/OneshotModelPinPicker';
import { useAuth } from '@/contexts/AuthContext';
import { useProviders } from '@/hooks/useProviders';
import { createLogger } from '@/lib/logger';
import { localizedModelName } from '@/lib/modelDisplayNames';
import { providerDisplayName } from '@/lib/providerDisplayName';
import { Spinner } from '@/components/ui/spinner';
import { CircleCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isModelEnabled, useModelVisibilityVersion } from '@/state/modelVisibilityPrefs';
import {
  AUTO_AUXILIARY_MODEL_CHAIN,
  AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS,
} from '../../../shared/auxiliaryModelChain';
import type {
  AuxiliaryModelOption,
  AuxiliaryModelSettingsState,
  AuxiliaryModelSettingsTestResult,
} from '../../../shared/auxiliaryModelSettings';
import { useAuxiliaryRouteHealth } from '@/hooks/useAuxiliaryRouteHealth';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { AuxiliaryModelHealthNotice } from './AuxiliaryModelHealthNotice';
import { useAuxiliaryModelHealth } from '@/hooks/useAuxiliaryModelHealth';

const log = createLogger('AuxiliaryModelSection');

const SLOT_I18N = ['preferred', 'fallback1', 'fallback2'] as const;
type AuxiliaryModelMode = 'automatic' | 'custom';
type AuxiliaryTestFailure = Extract<AuxiliaryModelSettingsTestResult, { ok: false }>;
/** Saved, failed, failed its test, or dropped because the account changed meanwhile. */
type AuxiliarySaveOutcome = boolean | AuxiliaryTestFailure | 'stale';

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
  const routeHealth = useAuxiliaryRouteHealth();
  const pendingRef = useRef(false);
  const modelVisibilityVersion = useModelVisibilityVersion();
  const health = useAuxiliaryModelHealth();

  useEffect(() => {
    let disposed = false;
    void window.electronAPI.maker
      .auxiliaryModelSettingsGet()
      .then((next) => {
        if (!disposed) {
          setSettings(next);
        }
      })
      .catch((error) => {
        log.warn('auxiliaryModelSettingsGet failed', error);
      });
    return () => {
      disposed = true;
    };
  }, [settingsRevision]);

  const persistModels = useCallback(
    async (models: string[]): Promise<AuxiliarySaveOutcome> => {
      if (pendingRef.current) return 'stale';
      pendingRef.current = true;
      setPending(true);
      const owner = getDataOwnerGeneration();
      try {
        const next = await window.electronAPI.maker.auxiliaryModelSettingsSet({ models });
        if (!isDataOwnerGenerationCurrent(owner)) return 'stale';
        if ('ok' in next) return next;
        setSettings(next);
        return true;
      } catch {
        if (!isDataOwnerGenerationCurrent(owner)) return 'stale';
        log.warn('auxiliaryModelSettingsSet failed');
        return false;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [],
  );

  const options = useMemo(() => {
    const providersById = new Map(providers.map((provider) => [provider.id, provider]));
    return (settings?.options ?? []).map((option) => {
      const customIcon = providersById.get(option.providerId)?.customIcon;
      return {
        ...option,
        ...(customIcon ? { customIcon } : {}),
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
      };
    });
  }, [providers, cindyAiName, cindyAiProvider?.logoKind, modelVisibilityVersion, settings?.options]);

  if (!settings) return null;

  return (
    <AuxiliaryModelSectionView
      models={settings.models}
      options={options}
      pending={pending}
      signInHint={authMode !== 'cloud'}
      drafting={drafting}
      setDrafting={setDrafting}
      persistModels={persistModels}
      health={health}
      routeHealth={routeHealth}
    />
  );
}

export interface AuxiliaryModelSectionViewProps {
  /** Persisted custom chain; empty = follow the automatic chain. */
  models: readonly string[];
  /** Slot catalog with availability already resolved by the owner (local: model visibility prefs). */
  options: readonly AuxiliaryModelOption[];
  pending: boolean;
  /** No Cindy AI routes (local / signed-out): show the sign-in hint and do not seed them into a draft. */
  signInHint: boolean;
  /** First-time Custom is a draft only, cleared by a successful save. */
  drafting: boolean;
  setDrafting: (drafting: boolean) => void;
  persistModels: (models: string[]) => Promise<AuxiliarySaveOutcome>;
  /** Cloud settings: a group that could not be read says so here, in place of the heading's action. */
  headingStatus?: React.ReactNode;
  /** Recent auxiliary failures of this computer; absent for another computer's settings. */
  health?: ReturnType<typeof useAuxiliaryModelHealth>;
  routeHealth?: ReturnType<typeof useAuxiliaryRouteHealth>;
}

/** Shared native view. Local and cloud controllers provide the same state/actions. */
export function AuxiliaryModelSectionView({
  models: savedModels,
  options,
  pending,
  signInHint,
  drafting,
  setDrafting,
  persistModels,
  headingStatus,
  health,
  routeHealth: healthSnapshots = [],
}: AuxiliaryModelSectionViewProps) {
  const { t } = useTranslation();
  const [draftModels, setDraftModels] = useState<readonly string[] | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'testing' | 'success' | 'failed' | 'restoring' | 'restored' | 'restoreFailed'>('idle');
  const [failedTest, setFailedTest] = useState<AuxiliaryTestFailure | null>(null);
  const savingRef = useRef(false);
  const save = async (next: readonly string[]): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveState(next.length ? 'testing' : 'restoring');
    setFailedTest(null);
    try {
      const outcome = await persistModels([...next]);
      if (outcome === 'stale') setSaveState('idle');
      else if (outcome === true) {
        setDraftModels(null);
        setSaveState(next.length ? 'success' : 'restored');
        setDrafting(false);
      } else if (outcome === false) setSaveState(next.length ? 'failed' : 'restoreFailed');
      else {
        setFailedTest(outcome);
        setSaveState('failed');
      }
    } finally {
      savingRef.current = false;
    }
  };
  const models = Array.isArray(savedModels) ? savedModels : [];
  const customized = models.length > 0;
  const showCustom = customized || drafting;
  // Keep the default/override split intact: first-time Custom is only a draft.
  // Local and signed-out sessions cannot use Cindy AI routes, so do not seed
  // those unavailable catalog pins into a draft that the user cannot select.
  const automaticDraftModels =
    !signInHint
      ? AUTO_AUXILIARY_MODEL_CHAIN.filter((ref) =>
          options.some((option) => option.id === ref && option.available),
        )
      : [];
  const activeModels = showCustom
    ? (draftModels ?? (customized ? models : automaticDraftModels))
    : [];
  const automaticChain = AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS.map((key) =>
    t(`settings.auxiliaryModels.chain.${key}`),
  ).join(' → ');
  const mode: AuxiliaryModelMode = showCustom ? 'custom' : 'automatic';

  const discardFeedback = () => {
    setSaveState('idle');
    setFailedTest(null);
  };
  const selectMode = (nextMode: AuxiliaryModelMode): void => {
    discardFeedback();
    if (nextMode === 'custom') {
      setDraftModels(customized ? models : automaticDraftModels);
      setDrafting(true);
      return;
    }
    if (!customized) {
      setDrafting(false);
      return;
    }
    void save([]);
  };

  const applySlot = (index: number, pin: string | null): void | boolean | Promise<boolean> => {
    if (index === 0 && !pin) {
      discardFeedback();
      if (customized) {
        setDraftModels([]);
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
    setDrafting(true);
    setDraftModels(unique);
    discardFeedback();
    return true;
  };

  const needsRetest = healthSnapshots.some(row => row.status === 'isolated' && row.auxiliaryRef && activeModels.includes(row.auxiliaryRef));
  const hasDraftChanges = JSON.stringify(draftModels ?? models) !== JSON.stringify(models);

  const failed = saveState === 'failed' || saveState === 'restoreFailed';
  const failedSlot = failedTest && SLOT_I18N[activeModels.indexOf(failedTest.model)];
  const failedModel = failedTest && localizedModelName(
    options.find(option => option.id === failedTest.model)?.modelName ?? failedTest.model, t,
  );
  const providerMessage = failedTest?.upstreamMessage;
  const foldDetails = providerMessage && (providerMessage.length > 200 || providerMessage.split('\n').length > 3);
  const saved = saveState === 'success' || saveState === 'restored';
  const statusKey = saveState === 'restoring' ? 'restoring' : saveState === 'testing' ? 'saving'
    : saveState === 'restored' ? 'restored' : saved ? 'saveSuccess' : 'draft';

  return (
    <SettingsSection
      title={t(personalizationDetailsSettings.auxiliaryModelsTitle.titleKey)}
      description={t(personalizationDetailsSettings.auxiliaryModelsTitle.descriptionKey)}
      action={headingStatus}
    >
      <SettingsCard>
        <SettingsRow wrap
          title={t(personalizationDetailsSettings.auxiliaryModelsTitle.titleKey)}
          trailing={
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
              {showCustom ? (
                <DefaultOverrideControls
                  isCustomized={customized || drafting}
                  showCustomizedBadge={customized}
                  disabled={pending}
                  onReset={() => {
                    if (!customized) {
                      discardFeedback();
                      setDrafting(false);
                      return;
                    }
                    void save([]);
                  }}
                />
              ) : null}
              {showCustom ? (
                <Button
                  variant="primary"
                  size="sm"
                  type="button"
                  data-settings-search-action="Test and save the selected auxiliary models"
                  disabled={pending || (!hasDraftChanges && !needsRetest && saveState !== 'failed')}
                  onClick={() => void save(activeModels)}
                >
                  {pending
                    ? t(`settings.auxiliaryModels.${statusKey}`)
                    : t(saveState === 'failed' ? 'settings.auxiliaryModels.retryAction' : 'settings.auxiliaryModels.save')}
                </Button>
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

        {failed ? (
          <ErrorNotice role="alert" data-auxiliary-save-feedback="failed"
            className="mx-4 mb-3 border-[var(--error-border)] bg-[var(--error-bg)]"
            message={<strong className="text-14 font-semibold">{t(failedTest
              ? customized ? 'settings.auxiliaryModels.failedKeep' : 'settings.auxiliaryModels.failedAuto'
              : saveState === 'restoreFailed' ? 'settings.defaults.restoreFailed' : 'settings.auxiliaryModels.saveFailed')}</strong>}
            description={failedTest && <>
              <span className="block font-medium text-[var(--text-primary)] [overflow-wrap:anywhere]">{failedSlot
                ? t('settings.auxiliaryModels.failedSlot', { slot: t(`settings.auxiliaryModels.${failedSlot}.label`), model: failedModel })
                : t('settings.auxiliaryModels.testFailed', { model: failedModel })}</span>
              <span className="block">{auxiliaryErrorSummary(failedTest, t)}</span>
              {!foldDetails && <AuxiliaryErrorDetail message={providerMessage} />}
            </>}
            details={foldDetails ? providerMessage : undefined}
          />
        ) : (pending || saved || (showCustom && hasDraftChanges)) && (
          <div role="status" data-auxiliary-save-feedback={saveState}
            className={cn('mx-4 mb-3 flex min-w-0 items-start gap-2 text-13 text-[var(--text-primary)]',
              pending && 'rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-3')}>
            {pending ? <Spinner size={18} className="mt-0.5" /> : saved && <CircleCheck aria-hidden="true" size={16} className="shrink-0 text-[var(--status-success)]" />}
            <div>
              <span className={pending ? 'font-semibold' : undefined}>{t(`settings.auxiliaryModels.${statusKey}`)}</span>
              {saveState === 'testing' && <p className="mt-1 text-12 text-[var(--text-secondary)]">{t('settings.auxiliaryModels.testingHint')}</p>}
            </div>
          </div>
        )}
        {health?.status === 'unavailable' ? (
          <SettingsBlock>
            <AuxiliaryModelHealthNotice
              health={health}
              onCustomize={showCustom ? undefined : () => selectMode('custom')}
            />
          </SettingsBlock>
        ) : null}

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
                    <div className="w-[min(55%,320px)] min-w-0">
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
              {signInHint ? (
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
            {signInHint ? (
              <p className="mt-1 text-12 leading-[1.5] text-[var(--text-tertiary)]">
                {t('settings.auxiliaryModels.signInHint')}
              </p>
            ) : null}
          </SettingsBlock>
        )}
        {healthSnapshots.length > 0 && (
          <SettingsBlock>
            {healthSnapshots.map((health) => (
              <p key={health.auxiliaryRef ?? JSON.stringify([health.providerId, health.model])} className="text-12 leading-[1.5] text-[var(--text-tertiary)]" role="status">
                {t('settings.auxiliaryModels.healthRecent', {
                  model: options.find(option => option.id === health.auxiliaryRef)?.modelName ?? health.model,
                  rate: health.attemptCount ? Math.round((1 - health.failureRate) * 100) : '—',
                  status: health.status === 'isolated' ? t('settings.auxiliaryModels.healthPaused') : health.status === 'recovered' ? t('settings.auxiliaryModels.healthRecovered', { model: health.model }) : t('settings.auxiliaryModels.healthMonitoring'),
                })}
                <span className="block">{t('settings.auxiliaryModels.lastError')}</span>
                <span className="block">{auxiliaryErrorSummary(health, t)}</span>
                <AuxiliaryErrorDetail message={health.upstreamMessage} />
              </p>
            ))}
          </SettingsBlock>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
