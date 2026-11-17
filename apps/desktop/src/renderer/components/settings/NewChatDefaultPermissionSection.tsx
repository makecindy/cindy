import { generalSettings } from './GeneralSettings.settings-search';
import { useTranslation } from 'react-i18next';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import { setNewChatDefaultPermissionMode, useNewMakerDraft } from '@/state/newMakerDraft';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const DEFAULT_MODES = ['auto', 'bypassPermissions'] as const;

export function NewChatDefaultPermissionSection() {
  const { t } = useTranslation();
  const draft = useNewMakerDraft();
  const override = draft.newChatDefaultPermissionMode;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-14 font-medium text-[var(--settings-section-title)]">
          {t(generalSettings.newChatPermission.titleKey)}
        </h3>
        <DefaultOverrideControls isCustomized={override != null}
          onReset={() => setNewChatDefaultPermissionMode(null)} />
      </div>
      <PermissionSelector permissionMode={override ?? 'auto'}
        vendorKey="cc" triggerVariant="field" allowedModes={DEFAULT_MODES}
        ariaContext={t(generalSettings.newChatPermission.titleKey)}
        onPermissionModeChange={setNewChatDefaultPermissionMode} />
    </div>
  );
}
