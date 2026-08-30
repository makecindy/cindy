/** Settings → Personalization: one ordered chain for short auxiliary text. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import * as Select from '@radix-ui/react-select';

import { OneshotModelPinPicker } from '@/cindy-brain/OneshotModelPinPicker';
import { useAuth } from '@/contexts/AuthContext';
import { createLogger } from '@/lib/logger';
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
  const { t } = useTranslation();
  const { mode: authMode } = useAuth();
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
  }, []);

  const persistModels = useCallback(
    async (models: string[]): Promise<void> => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      try {
        const next = await window.electronAPI.maker.auxiliaryModelSettingsSet({ models });
        setSettings(next);
        if (models.length === 0) setDrafting(false);
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

  const options = useMemo(
    () =>
      (settings?.options ?? []).map((option) => ({
        ...option,
        available:
          option.available !== false &&
          isModelEnabled(option.agentKind, option.providerId, {
            id: option.modelId,
            defaultEnabled: option.defaultEnabled,
          }),
      })),
    [modelVisibilityVersion, settings?.options],
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

  const applySlot = (index: number, pin: string | null): void => {
    if (index === 0 && !pin) {
      if (customized) {
        void persistModels([]);
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
      slots[index] = pin;
    }
    const unique: string[] = [];
    for (const entry of slots) {
      if (entry && !unique.includes(entry)) unique.push(entry);
    }
    void persistModels(unique);
  };

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
          <div className="min-w-0 flex-1 text-14 font-medium text-[var(--text-primary)]">
            {t('settings.auxiliaryModels.title')}
          </div>
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
            <Select.Root
              value={mode}
              onValueChange={(value) => selectMode(value as AuxiliaryModelMode)}
              disabled={pending}
            >
              <Select.Trigger
                aria-label={t('settings.auxiliaryModels.title')}
                className={cn(
                  'flex h-9 w-[220px] max-w-full min-w-0 shrink items-center justify-between gap-3 rounded-full border px-3.5 text-13 outline-none transition-colors',
                  'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                  'hover:bg-[var(--settings-menu-bg-hover)] focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
                  'disabled:cursor-not-allowed disabled:opacity-55',
                )}
              >
                <span className="min-w-0 truncate text-left">
                  <Select.Value />
                </span>
                <Select.Icon asChild>
                  <ChevronDown
                    size={14}
                    className="shrink-0 text-[var(--settings-eye-icon)]"
                    aria-hidden="true"
                  />
                </Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content
                  position="popper"
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  className={cn(
                    'z-[10010] w-[var(--radix-select-trigger-width)] min-w-[220px] overflow-hidden rounded-xl p-2',
                    'border border-[var(--settings-input-border)] bg-[var(--settings-theme-card-bg)]',
                  )}
                >
                  <Select.Viewport className="flex flex-col gap-[2px]">
                    {(['automatic', 'custom'] as const).map((option) => (
                      <Select.Item
                        key={option}
                        value={option}
                        className={cn(
                          'flex h-9 w-full cursor-pointer select-none items-center justify-between gap-3 rounded-[8px] px-3 text-left text-13 outline-none transition-colors',
                          'text-[var(--settings-input-text)] data-[highlighted]:bg-[var(--settings-menu-bg-hover)]',
                          'data-[state=checked]:bg-[var(--settings-menu-bg-selected)] data-[state=checked]:font-medium data-[state=checked]:text-[var(--settings-menu-text-selected)]',
                        )}
                      >
                        <Select.ItemText className="min-w-0 flex-1 whitespace-nowrap">
                          {t(
                            option === 'automatic'
                              ? 'settings.auxiliaryModels.automatic'
                              : 'settings.auxiliaryModels.customize',
                          )}
                        </Select.ItemText>
                        <Select.ItemIndicator>
                          <Check
                            size={16}
                            className="shrink-0 text-[var(--settings-theme-icon-active)]"
                          />
                        </Select.ItemIndicator>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
          </div>
        </div>

        <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

        {showCustom ? (
          <>
            {SLOT_I18N.map((slotKey, index) => {
              const pin = activeModels[index];
              return (
                <div key={slotKey}>
                  {index > 0 ? (
                    <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />
                  ) : null}
                  <div className="flex items-center justify-between gap-4 px-4 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="text-14 font-medium text-[var(--text-primary)]">
                        {t(`settings.auxiliaryModels.${slotKey}.label`)}
                      </div>
                      <p className="mt-1 text-12 leading-[1.5] text-[var(--text-tertiary)]">
                        {t(`settings.auxiliaryModels.${slotKey}.description`)}
                      </p>
                    </div>
                    <div className="w-[min(100%,320px)] shrink-0">
                      {/* One-shot pins already carry the exact provider + agent route. The
                          provider-first picker exposes every routable supplier without
                          surfacing Harness or a thinking-depth control. */}
                      <OneshotModelPinPicker
                        value={pin ?? undefined}
                        defaultLabel=""
                        declaredLabel={null}
                        options={options}
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
                        disabled={pending}
                      />
                    </div>
                  </div>
                </div>
              );
            })}

            <p className="px-4 pb-4 text-12 leading-[1.5] text-[var(--text-secondary)]">
              {authMode !== 'cloud' ? (
                <span className="mb-1 block text-[var(--text-tertiary)]">
                  {t('settings.auxiliaryModels.signInHint')}
                </span>
              ) : null}
              {t('settings.auxiliaryModels.customHint')}
            </p>
          </>
        ) : (
          <div className="px-4 py-4">
            <p className="text-12 leading-[1.5] text-[var(--text-tertiary)]">
              {automaticChain}
            </p>
            {authMode !== 'cloud' ? (
              <p className="mt-1 text-12 leading-[1.5] text-[var(--text-tertiary)]">
                {t('settings.auxiliaryModels.signInHint')}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
