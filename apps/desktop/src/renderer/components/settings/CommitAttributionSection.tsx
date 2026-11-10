import { additionalSettings } from './AdditionalSettings.settings-search';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { useSettingDefinition } from './useSettingDefinition';

const log = createLogger('CommitAttributionSection');

export function CommitAttributionSection() {
  const setting = useSettingDefinition(additionalSettings.commitAttribution);
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [isCustomized, setIsCustomized] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker.commitAttributionGet()
      .then((settings) => {
        if (cancelled) return;
        setEnabled(settings.enabled);
        setIsCustomized(settings.isCustomized);
        setReady(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        log.warn('commitAttributionGet failed', err);
        toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.commitAttribution.saveFailed' })));
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleToggle = useCallback(async (next: boolean) => {
    const previous = { enabled, isCustomized };
    setEnabled(next);
    setPending(true);
    try {
      const settings = await window.electronAPI.maker.commitAttributionSet(next);
      setEnabled(settings.enabled);
      setIsCustomized(settings.isCustomized);
    } catch (err) {
      log.warn('commitAttributionSet failed', err);
      setEnabled(previous.enabled);
      setIsCustomized(previous.isCustomized);
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.commitAttribution.saveFailed' })));
    } finally {
      setPending(false);
    }
  }, [enabled, isCustomized, t]);

  const handleReset = useCallback(async () => {
    setPending(true);
    try {
      const settings = await window.electronAPI.maker.commitAttributionReset();
      setEnabled(settings.enabled);
      setIsCustomized(settings.isCustomized);
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      log.warn('commitAttributionReset failed', err);
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.defaults.restoreFailed' })));
    } finally {
      setPending(false);
    }
  }, [t]);

  return (
    <SettingsSection title={t('settings.commitAttribution.title')}>
      <SettingsCard>
        <SettingsRow
          {...setting.anchorProps}
          title={setting.title}
          hint={setting.description}
          trailing={
            <div className="flex items-center gap-2">
              <DefaultOverrideControls
                isCustomized={isCustomized}
                disabled={pending}
                onReset={() => void handleReset()}
              />
              <Switch
                {...setting.controlProps}
                checked={enabled}
                disabled={!ready || pending}
                onCheckedChange={(next) => void handleToggle(next)}
                aria-label={t('settings.commitAttribution.toggleAria')}
              />
            </div>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
