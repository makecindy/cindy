import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { useComposerFollowUpPreference } from '@/hooks/useComposerFollowUpPreference';
import {
  getComposerModifierShortcutLabel,
  getComposerSendShortcutLabel,
  useComposerSendShortcutPreference,
} from '@/hooks/useComposerSendShortcutPreference';
import { toast } from '@/lib/toast';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { useSettingDefinition } from './useSettingDefinition';

// The follow-up row has no restore control: Queue is the default, so choosing it
// removes the override (see useComposerFollowUpPreference).
function ComposerFollowUpRow() {
  const { t } = useTranslation();
  const { preference: sendShortcut } = useComposerSendShortcutPreference();
  const { preference, setPreference } = useComposerFollowUpPreference();
  const setting = useSettingDefinition(personalizationDetailsSettings.composerFollowUpBehaviorLabel);
  const send = getComposerSendShortcutLabel(sendShortcut, window.electronAPI?.platform);

  return (
    <SettingsRow
      {...setting.anchorProps}
      className="cindy-segmented-row"
      title={setting.title}
      hint={t(`settings.composer.followUp.hint${preference === 'steer' ? 'Steer' : 'Queue'}`, { send })}
      trailing={
        <div className="cindy-segmented-row-actions">
          <SegmentedControl
            {...setting.controlProps}
            aria-label={t('settings.composer.followUp.ariaLabel')}
            value={preference}
            onValueChange={setPreference}
            options={setting.options}
          />
        </div>
      }
    />
  );
}

export function ComposerSendShortcutSection() {
  const { t } = useTranslation();
  const { preference, setPreference } = useComposerSendShortcutPreference();
  const shortcut = getComposerModifierShortcutLabel(window.electronAPI?.platform);

  return (
    <SettingsSection title={t('settings.composer.title')}>
      <SettingsCard>
        <SettingsRow
          title={t(personalizationDetailsSettings.composerSendShortcutLabel.titleKey, { shortcut })}
          hint={t(
            preference === 'modifier-enter'
              ? 'settings.composer.sendShortcut.hintModifierEnter'
              : personalizationDetailsSettings.composerSendShortcutLabel.descriptionKey,
            { shortcut },
          )}
          trailing={
            <div className="flex shrink-0 items-center gap-2">
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
        <ComposerFollowUpRow />
      </SettingsCard>
    </SettingsSection>
  );
}
