import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Puzzle } from 'lucide-react';
import { effectiveSourceIdForModel, type ProviderView } from '@cindy/model-providers';

import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { useProviders } from '@/hooks/useProviders';
import { toast } from '@/lib/toast';
import {
  isKnownTextOnlyModel,
  VISION_FALLBACK_AGENTS,
  type SubagentModelSettingsState,
  type VisionFallbackProviderIds,
} from '../../../shared/subagentModelSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

function providerIdsForVisionFallback(
  providers: ProviderView[],
  preferredProviderId: string | null,
  modelId: string,
): VisionFallbackProviderIds {
  return Object.fromEntries(
    VISION_FALLBACK_AGENTS.flatMap((agent) => {
      const providerId = effectiveSourceIdForModel(
        providers,
        preferredProviderId,
        modelId,
        agent,
      );
      return providerId ? [[agent, providerId]] : [];
    }),
  ) as VisionFallbackProviderIds;
}

export function VisionFallbackRow() {
  const { t } = useTranslation();
  const { providers } = useProviders();
  const [settings, setSettings] = useState<SubagentModelSettingsState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let disposed = false;
    void window.electronAPI.maker.subagentModelSettingsGet()
      .then((next) => {
        if (!disposed) setSettings(next);
      })
      .catch(() => {
        if (!disposed) toast.error(t('settings.subagentModels.saveFailed'));
      });
    return () => {
      disposed = true;
    };
  }, [t]);

  const save = useCallback(async (patch: {
    visionFallbackEnabled?: boolean;
    visionFallbackModel?: string | null;
    visionFallbackProviderId?: string | null;
    visionFallbackProviderIds?: VisionFallbackProviderIds;
  }) => {
    if (!settings || Object.entries(patch).every(([key, value]) => settings[key as keyof SubagentModelSettingsState] === value)) return;
    setPending(true);
    try {
      const next = await window.electronAPI.maker.subagentModelSettingsSet({
        ...patch,
      });
      setSettings(next);
      toast.success(t('settings.subagentModels.toast.saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.subagentModels.saveFailed'));
    } finally {
      setPending(false);
    }
  }, [settings, t]);

  if (!settings) return null;

  const isCustomized = settings.customizedKeys.includes('visionFallbackModel')
    || settings.customizedKeys.includes('visionFallbackProviderId')
    || settings.customizedKeys.includes('visionFallbackProviderIds')
    || settings.customizedKeys.includes('visionFallbackEnabled');
  const sourceKey = isCustomized ? 'user' : 'product';
  const configuredFallbackIsTextOnly = settings.visionFallbackModel !== null
    && isKnownTextOnlyModel(settings.visionFallbackModel);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-[14px]">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          'bg-[var(--settings-input-bg)]',
        )}>
          <Puzzle size={16} className="text-[var(--settings-section-title)]" />
        </div>
        <div className="flex min-w-0 flex-col gap-[8px]">
          <div className="flex items-center gap-2">
            <p className="truncate text-14 font-medium leading-[1.25] text-[var(--settings-section-title)]">
              {t('settings.subagentModels.visionFallbackLabel')}
            </p>
            <span
              className="shrink-0 rounded-full bg-[var(--settings-input-bg)] px-1.5 py-0.5 text-11 leading-none text-[var(--settings-section-desc)]"
              title={t(`settings.builtinTools.source.${sourceKey}Tooltip`)}
            >
              {t(`settings.builtinTools.source.${sourceKey}`)}
            </span>
          </div>
          <p className="truncate text-12 leading-[1.35] text-[var(--settings-section-desc)]">
            {configuredFallbackIsTextOnly
              ? t('settings.subagentModels.visionFallbackTextOnlyWarning')
              : t('settings.subagentModels.visionFallbackHint')}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="w-[min(320px,30vw)]">
          <ModelSelector
            modelId={settings.visionFallbackModel ?? ''}
            effort=""
            onModelChange={(model) => void save({
              visionFallbackModel: model,
              visionFallbackProviderIds: providerIdsForVisionFallback(
                providers,
                settings.visionFallbackProviderId,
                model,
              ),
            })}
            onEffortChange={() => undefined}
            currentProviderId={settings.visionFallbackProviderId}
            onProviderChange={(providerId, modelId) => {
              const nextModel = modelId ?? settings.visionFallbackModel;
              if (!nextModel) return;
              void save({
                visionFallbackModel: nextModel,
                visionFallbackProviderId: providerId,
                visionFallbackProviderIds: providerIdsForVisionFallback(
                  providers,
                  providerId,
                  nextModel,
                ),
              });
            }}
            configurationEnabled={false}
            switching={pending}
            disabled={pending}
            triggerVariant="field"
            popoverSide="bottom"
            unknownModelLabel={(id) => id.replace(/^codex\//, '')}
            fallbackOption={{
              active: settings.visionFallbackModel === null,
              label: t('settings.subagentModels.visionFallbackAutomatic'),
              onSelect: () => void save({
                visionFallbackModel: null,
                visionFallbackProviderId: null,
                visionFallbackProviderIds: {},
              }),
            }}
          />
        </div>
        <DefaultOverrideControls
          isCustomized={isCustomized}
          disabled={pending}
          onReset={() => void save({
            visionFallbackEnabled: true,
            visionFallbackModel: null,
            visionFallbackProviderId: null,
            visionFallbackProviderIds: {},
          })}
        />
        <Switch
          checked={settings.visionFallbackEnabled}
          disabled={pending}
          onCheckedChange={(enabled) => void save({ visionFallbackEnabled: enabled })}
          aria-label={t('settings.subagentModels.visionFallbackEnabledAria')}
        />
      </div>
    </div>
  );
}
