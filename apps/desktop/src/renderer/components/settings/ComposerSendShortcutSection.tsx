import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import {
  getComposerModifierShortcutLabel,
  useComposerSendShortcutPreference,
} from '@/hooks/useComposerSendShortcutPreference';
import { toast } from '@/lib/toast';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { DefaultOverrideControls } from './DefaultOverrideControls';

export function ComposerSendShortcutSection() {
  const { t } = useTranslation();
  const { preference, isCustomized, setPreference } = useComposerSendShortcutPreference();
  const shortcut = getComposerModifierShortcutLabel(window.electronAPI?.platform);

  const onReset = useCallback(() => {
    setPreference('enter');
    toast.success(t('settings.defaults.restored'));
  }, [setPreference, t]);

  return (
    <SettingsSection title={t('settings.composer.title')}>
      <SettingsCard>
        <SettingsRow
          title={t(personalizationDetailsSettings.composerSendShortcutLabel.titleKey, { shortcut })}
          hint={t(personalizationDetailsSettings.composerSendShortcutLabel.descriptionKey, { shortcut })}
          trailing={
            <div className="flex shrink-0 items-center gap-2">
              <DefaultOverrideControls isCustomized={isCustomized} onReset={onReset} />
              <Switch data-setting-id={personalizationDetailsSettings.composerSendShortcutLabel.id}
                checked={preference === 'modifier-enter'}
                onCheckedChange={(enabled) => {
                  const result = setPreference(enabled ? 'modifier-enter' : 'enter');
                  if (!result.ok && result.conflict === 'composer-voice-input') {
                    toast.error(t('settings.shortcuts.errors.composerVoiceConflict'));
                  }
                }}
                aria-label={t('settings.composer.sendShortcut.ariaLabel', { shortcut })}
              />
            </div>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
