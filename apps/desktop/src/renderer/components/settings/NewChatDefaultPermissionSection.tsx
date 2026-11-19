import { generalSettings } from './GeneralSettings.settings-search';
import { useTranslation } from 'react-i18next';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import { SettingsField } from '@/components/ui/settings-rows';
import { setNewChatDefaultPermissionMode, useNewMakerDraft } from '@/state/newMakerDraft';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const DEFAULT_MODES = ['auto', 'bypassPermissions'] as const;

export function NewChatDefaultPermissionSection() {
  const { t } = useTranslation();
  const draft = useNewMakerDraft();
  const override = draft.newChatDefaultPermissionMode;
  return (
    <SettingsField
      title={t(generalSettings.newChatPermission.titleKey)}
      action={<DefaultOverrideControls isCustomized={override != null}
        onReset={() => setNewChatDefaultPermissionMode(null)} />}
    >
      <PermissionSelector permissionMode={override ?? 'auto'}
        vendorKey="cc" triggerVariant="field" allowedModes={DEFAULT_MODES}
        ariaContext={t(generalSettings.newChatPermission.titleKey)}
        onPermissionModeChange={setNewChatDefaultPermissionMode} />
    </SettingsField>
  );
}
