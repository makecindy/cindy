import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { PluginEngineEffort, PluginEngineModel } from '../../../shared/pluginEngines';
import { providersSettings } from './ProvidersSection.settings-search';

export function PluginModelAdvancedDialog({ model, providerName, customized, onSave, onClose, onCloseAutoFocus }: {
  model: PluginEngineModel;
  providerName: string;
  customized: boolean;
  onSave: (effort: PluginEngineEffort | null) => Promise<boolean>;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t } = useTranslation();
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
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
        <Dialog.Content
          className="modal-panel fixed inset-0 z-modal m-auto flex h-fit max-h-[calc(100%-32px)] w-[calc(100%-32px)] max-w-[560px] flex-col overflow-hidden"
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <header className="flex items-start justify-between gap-3 border-b border-[var(--border-default)] px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="break-words text-16 font-semibold">{model.displayName || model.id}</Dialog.Title>
              <p className="text-12 text-[var(--text-tertiary)]">{providerName}</p>
            </div>
            <Dialog.Close asChild>
              <Button data-settings-search-action="Close the plugin model settings" variant="secondary" tone="quiet" size="sm" className="w-7 !px-0"
                aria-label={t('settings.providers.models.advanced.close')}>
                <X size={16} aria-hidden />
              </Button>
            </Dialog.Close>
          </header>
          <div className="min-h-0 space-y-5 overflow-y-auto px-5 py-4">
            {(offered.length > 0 || customized) && (
              <section>
                <h3 className="mb-1 text-13 font-medium">{t('settings.providers.models.advanced.defaultEffort')}</h3>
                {offered.length > 0 && <>
                  <p className="mb-2 text-12 text-[var(--text-tertiary)]">{t('settings.providers.models.advanced.defaultEffortHint')}</p>
                  <SegmentedControl
                    data-setting-id={providersSettings.pluginProviders.id}
                    aria-label={t('settings.providers.models.advanced.defaultEffort')}
                    fullWidth
                    className="grid grid-cols-3"
                    optionClassName="!min-w-0"
                    options={offered.map(effort => ({ value: effort, label: t(`effortLevels.${effort}`) }))}
                    value={value}
                    disabled={saving}
                    onValueChange={effort => void save(effort)}
                  />
                </>}
                {customized && (
                  <Button data-settings-search-action="Restore the plugin's default for this model" variant="secondary"
                    size="sm" className="mt-2" disabled={saving} onClick={() => void save(null)}>
                    {t('settings.providers.models.advanced.restoreDefault')}
                  </Button>
                )}
              </section>
            )}
            <section>
              <h3 className="mb-2 text-13 font-medium">{t('settings.providers.models.advanced.identity')}</h3>
              {model.description && <p className="mb-2 break-words text-12 text-[var(--text-secondary)]">{model.description}</p>}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-12">
                <dt className="text-[var(--text-tertiary)]">{t('settings.providers.models.advanced.modelId')}</dt>
                <dd className="break-all text-right">{model.id}</dd>
                <dt className="text-[var(--text-tertiary)]">{t('settings.providers.models.advanced.providerLabel')}</dt>
                <dd className="break-words text-right">{providerName}</dd>
              </dl>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
