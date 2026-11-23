import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NativePullDownMenu, usesNativePullDownMenu } from '@/platform/chrome';
import { AnchoredPullDownMenu } from '@/platform/chrome/AnchoredPullDownMenu';
import { ChoicePickerRow, SettingsGroup } from '@/session/SettingsGroupRows';
import { saveComposerFollowUpMode, useComposerFollowUpMode } from './composerFollowUpPreference';

export function ComposerFollowUpSettings() {
  const { t } = useTranslation();
  const mode = useComposerFollowUpMode();
  const [failed, setFailed] = useState(false);
  const saving = useRef(false);
  const Menu = usesNativePullDownMenu() ? NativePullDownMenu : AnchoredPullDownMenu;
  const label = t('settings.composerFollowUp.label');
  const value = t(`settings.composerFollowUp.${mode}`);

  async function select(id: string) {
    if ((id !== 'queue' && id !== 'steer') || saving.current) return;
    saving.current = true;
    setFailed(false);
    try {
      await saveComposerFollowUpMode(id);
    } catch {
      setFailed(true);
    } finally {
      saving.current = false;
    }
  }

  return (
    <SettingsGroup
      title={t('settings.composerFollowUp.title')}
      footer={t('settings.composerFollowUp.description')}
      messages={[failed ? { text: t('settings.composerFollowUp.saveFailed') } : null]}
    >
      <Menu
        accessibilityLabel={`${label}: ${value}`}
        actions={(['queue', 'steer'] as const).map(id => ({
          id,
          state: id === mode ? 'on' : 'off',
          title: t(`settings.composerFollowUp.${id}`),
        }))}
        onAction={id => { void select(id); }}
        testID="settings.composerFollowUp"
      >
        <ChoicePickerRow expanded={false} label={label} value={value} onPress={() => undefined} />
      </Menu>
    </SettingsGroup>
  );
}
