import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { useLastTurnStatisticsPreference } from '@/hooks/useLastTurnStatisticsPreference';
import { additionalSettings } from './AdditionalSettings.settings-search';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { useSettingDefinition } from './useSettingDefinition';
import { useSettingsSearchNavigation } from './SettingsSearchNavigation';

export function LastTurnStatisticsCell() {
  const setting = useSettingDefinition(additionalSettings.lastTurnStatistics);
  const { enabled, isCustomized, setEnabled } = useLastTurnStatisticsPreference();
  return <SettingsRow {...setting.anchorProps} title={setting.title} hint={setting.description}
    trailing={<div className="flex items-center gap-2">
      <DefaultOverrideControls isCustomized={isCustomized} onReset={() => setEnabled(false)} />
      <Switch {...setting.controlProps} checked={enabled} onCheckedChange={setEnabled} aria-label={setting.title} />
    </div>} />;
}

/** A low-frequency display preference lives in the category's collapsed advanced group. */
export function LastTurnStatisticsSettings() {
  const { t } = useTranslation();
  const details = useRef<HTMLDetailsElement>(null);
  const navigation = useSettingsSearchNavigation();
  useEffect(() => {
    if (navigation.entry?.id === additionalSettings.lastTurnStatistics.id && details.current) {
      details.current.open = true;
    }
  }, [navigation.entry, navigation.activation]);
  return <details ref={details} className="mt-3">
    <summary className="cursor-pointer py-2 text-13 font-medium text-[var(--text-secondary)]">
      {t('settings.lastTurnStatistics.advanced')}
    </summary>
    <SettingsCard><LastTurnStatisticsCell /></SettingsCard>
  </details>;
}
