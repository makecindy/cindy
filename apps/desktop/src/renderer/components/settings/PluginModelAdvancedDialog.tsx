import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ResetGroupButton } from '@/components/ui/reset-buttons';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { modelBrand, localizedBrandName } from '@/lib/modelDisplayNames';
import type { PluginEngineEffort, PluginEngineModel, PluginEngineReportedModelDetails } from '../../../shared/pluginEngines';
import {
  ModelAdvancedColumns, ModelAdvancedFooter, ModelAdvancedContent, ModelAdvancedRow, ModelAdvancedSection,
} from './ModelAdvancedLayout';
import { providersSettings } from './ProvidersSection.settings-search';

export function PluginModelAdvancedDialog({
  model, reported, antigravity, providerName, customized, enabled, visibilityBusy, onToggle, onSave, onClose, onCloseAutoFocus,
}: {
  model: PluginEngineModel;
  reported?: PluginEngineReportedModelDetails | undefined;
  antigravity?: boolean;
  providerName: string;
  customized: boolean;
  enabled: boolean;
  visibilityBusy: boolean;
  onToggle: (enabled: boolean) => void;
  onSave: (effort: PluginEngineEffort | null) => Promise<boolean>;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t, i18n } = useTranslation();
  const contextWindow = reported?.contextWindow;
  const imageInput = reported?.imageInput;
  const isHydrogen = antigravity && model.id === 'gemini-4-hydrogen';
  const isNeon = antigravity && model.id === 'gemini-4-neon';
  // The Antigravity model guide declares 512K for Neon, not for Hydrogen.
  // https://antigravity.google/docs/models#gemini-4-neon
  const brand = isHydrogen || isNeon ? modelBrand(model) : undefined;
  // Antigravity's model guide publishes "up to 512K" for Neon only. Keep its unit.
  const officialContextWindow = isNeon ? '512K' : undefined;
  const [saving, setSaving] = useState(false);
  const offered = model.efforts ?? [];
  const value = offered.find(effort => effort === model.defaultEffort) ?? null;

  async function save(effort: PluginEngineEffort | null) {
    setSaving(true);
    try {
      await onSave(effort);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <ModelAdvancedContent
          title={model.displayName || model.id}
          providerName={providerName}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <ModelAdvancedColumns
            left={<>
              <ModelAdvancedSection title={t('settings.providers.models.advanced.engines')}>
                <ModelAdvancedRow label={t('settings.providers.models.advanced.protocol.upstream')}>ACP</ModelAdvancedRow>
              </ModelAdvancedSection>
              <ModelAdvancedSection
                title={t('settings.providers.models.advanced.defaultEffort')}
                hint={t('settings.providers.models.advanced.defaultEffortHint')}
              >
                {offered.length > 0 && (
                  <SegmentedControl
                    data-setting-id={providersSettings.pluginProviders.id}
                    className="mt-1"
                    fullWidth
                    style={offered.length > 4 ? {
                      display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', borderRadius: 'var(--radius-xl)',
                    } : undefined}
                    optionClassName={offered.length > 4 ? '!min-w-0 px-1' : undefined}
                    height={32}
                    optionHeight={24}
                    aria-label={t('settings.providers.models.advanced.defaultEffort')}
                    options={offered.map(effort => ({ value: effort, label: t(`effortLevels.${effort}`) }))}
                    value={value}
                    disabled={saving}
                    onValueChange={effort => void save(effort)}
                  />
                )}
                {value === null && <p className="py-2 text-13 text-[var(--text-tertiary)]">-</p>}
                {customized && (
                  <ResetGroupButton
                    data-settings-search-action="Restore the plugin's default for this model"
                    className="mt-2"
                    disabled={saving}
                    onClick={() => void save(null)}
                    label={t('settings.providers.models.advanced.restoreDefault')}
                  />
                )}
              </ModelAdvancedSection>
              <ModelAdvancedSection title={t('settings.providers.models.advanced.contextLimit')}>
                {contextWindow === undefined
                  ? <p className="py-2 text-13 text-[var(--text-tertiary)]">-</p>
                  : <p className="py-2 text-13 text-[var(--text-primary)]">
                      {t('settings.providers.models.advanced.contextLimitRoute', {
                        tokens: new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language ?? 'en').format(contextWindow),
                      })}
                    </p>}
                <ModelAdvancedRow label={t('settings.providers.models.advanced.compaction.title')} muted>-</ModelAdvancedRow>
              </ModelAdvancedSection>
              <ModelAdvancedSection title={t('settings.providers.models.advanced.spec')}>
                <ModelAdvancedRow label={t('settings.providers.models.advanced.contextWindow')} muted={officialContextWindow === undefined}>
                  {officialContextWindow ?? '-'}
                </ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.advanced.maxOutput')} muted>-</ModelAdvancedRow>
              </ModelAdvancedSection>
            </>}
            right={<>
              <ModelAdvancedSection title={t('settings.providers.models.advanced.capability')}>
                <ModelAdvancedRow label={t('settings.providers.models.advanced.imageInput')} muted={imageInput === undefined}>
                  {imageInput === undefined ? '-' : t(imageInput
                    ? 'settings.providers.models.advanced.supported'
                    : 'settings.providers.models.advanced.unsupported')}
                </ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.advanced.inputModalities')} muted>-</ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.advanced.outputModalities')} muted>-</ModelAdvancedRow>
                <ModelAdvancedRow label="Fast" muted>-</ModelAdvancedRow>
                <ModelAdvancedRow label={t('newChat.modelSelector.speed.ultrafast')} muted>-</ModelAdvancedRow>
              </ModelAdvancedSection>
              <ModelAdvancedSection title={t('settings.providers.models.advanced.pricing')}>
                <ModelAdvancedRow label={t('settings.providers.models.priceOverride.currency')} muted>-</ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.priceOverride.input')} muted>-</ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.priceOverride.output')} muted>-</ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.priceOverride.cacheRead')} muted>-</ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.priceOverride.cacheWrite')} muted>-</ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.advanced.discount')} muted>-</ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.priceOverride.referenceDetails')} muted>-</ModelAdvancedRow>
              </ModelAdvancedSection>
              <ModelAdvancedSection title={t('settings.providers.models.advanced.identity')}>
                  <p className="mb-2 break-words text-12 leading-relaxed text-[var(--text-secondary)]">
                    {model.description || (isHydrogen ? t('settings.providers.models.advanced.antigravityHydrogenDescription') : '-')}
                  </p>
                <ModelAdvancedRow label={t('settings.providers.models.advanced.modelId')}>
                  <code className="select-text break-all text-12">{model.id}</code>
                </ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.management.brand')} muted={!brand}>
                  {brand ? localizedBrandName(brand, t) : '-'}
                </ModelAdvancedRow>
                <ModelAdvancedRow label={t('settings.providers.models.advanced.status')} muted>-</ModelAdvancedRow>
              </ModelAdvancedSection>
            </>}
          />
          <ModelAdvancedFooter>
            <Button variant="secondary" size="md" compact type="button" disabled={visibilityBusy || saving}
              data-setting-id={providersSettings.pluginProviders.id} onClick={() => onToggle(!enabled)}>
              {t(enabled ? 'settings.providers.models.disableModel' : 'settings.providers.models.enableModel')}
            </Button>
          </ModelAdvancedFooter>
        </ModelAdvancedContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
