import { additionalSettings } from '@/components/settings/AdditionalSettings.settings-search';
import { useSettingDefinition } from '@/components/settings/useSettingDefinition';
import { useBotTranslation } from './botPronounContext';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { useBotReplyTargetPreference } from './useBotReplyTargetPreference';

export function BotsGlobalSettingsSection() {
  const { t } = useBotTranslation();
  const replySetting = useSettingDefinition(additionalSettings.botReplyTarget, t);
  const replyTarget = useBotReplyTargetPreference();

  return (
    <SettingsSection title={t('bots.globalSettings.title')}>
      <SettingsCard>
        <SettingsRow
          {...replySetting.anchorProps}
          title={replySetting.title}
          hint={replySetting.description}
          trailing={
            <Switch {...replySetting.controlProps}
              aria-label={replySetting.title}
              className="shrink-0"
              checked={replyTarget.enabled}
              onCheckedChange={(value) => replyTarget.setEnabled(value === true)}
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
