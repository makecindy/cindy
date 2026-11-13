import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionInfoRow, SettingsGroup, SettingsSwitchRow } from '@/session/SettingsGroupRows';
import { savePromptRecommendationPreference, usePromptRecommendationPreference } from '@/session/promptRecommendationPreference';

export function PromptRecommendationSettings() {
  const { t } = useTranslation();
  const { ready, enabled, customized } = usePromptRecommendationPreference();
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const save = async (value: boolean | null) => {
    setFailed(false);
    setSaving(true);
    try {
      await savePromptRecommendationPreference(value);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsGroup
      footer={t('settings.promptRecommendation.description')}
      messages={[failed ? { text: t('settings.promptRecommendation.saveFailed') } : null]}
      testID="settings.promptRecommendation"
    >
      <SettingsSwitchRow
        label={t('settings.promptRecommendation.label')}
        value={enabled}
        disabled={!ready || saving}
        onValueChange={value => { void save(value); }}
        switchTestID="settings.promptRecommendation.switch"
      />
      {customized ? (
        <ActionInfoRow
          label={t('settings.promptRecommendation.reset')}
          accessibilityLabel={t('settings.promptRecommendation.reset')}
          value=""
          chevron={false}
          disabled={saving}
          onPress={() => { void save(null); }}
          testID="settings.promptRecommendation.reset"
        />
      ) : null}
    </SettingsGroup>
  );
}
