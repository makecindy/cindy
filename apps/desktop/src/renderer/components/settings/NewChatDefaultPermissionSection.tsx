import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { requiresFullAccessConfirmation } from '@cindy/maker-shared/permission-mode';
import { FullAccessConfirmContent } from '@/components/new-chat/FullAccessConfirmContent';
import { PermissionSelector } from '@/components/new-chat/PermissionSelector';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { PermissionMode } from '@/lib/userPreferences.types';
import { setNewChatDefaultPermissionMode, useNewMakerDraft } from '@/state/newMakerDraft';
import { DefaultOverrideControls } from './DefaultOverrideControls';

const DEFAULT_MODES = ['auto', 'bypassPermissions'] as const;

export function NewChatDefaultPermissionSection() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const draft = useNewMakerDraft();
  const override = draft.newChatDefaultPermissionMode;
  const changePermissionMode = async (nextMode: PermissionMode) => {
    const owner = getDataOwnerGeneration();
    if (requiresFullAccessConfirmation(override ?? 'auto', nextMode)) {
      const confirmed = await confirm({
        title: t('newChat.chatInput.fullAccessConfirmation.title'),
        description: t('newChat.chatInput.fullAccessConfirmation.description'),
        content: <FullAccessConfirmContent />,
        describeContent: true,
        maxWidth: 440,
        confirmText: t('newChat.chatInput.fullAccessConfirmation.confirm'),
        cancelText: t('newChat.chatInput.fullAccessConfirmation.cancel'),
        confirmIcon: <TriangleAlert size={14} />,
      });
      if (!confirmed || !isDataOwnerGenerationCurrent(owner)) return;
    }
    setNewChatDefaultPermissionMode(nextMode);
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-14 font-medium text-[var(--settings-section-title)]">
          {t('settings.newChatDefaults.title')}
        </h3>
        <DefaultOverrideControls isCustomized={override != null}
          onReset={() => setNewChatDefaultPermissionMode(null)} />
      </div>
      <PermissionSelector permissionMode={override ?? 'auto'}
        vendorKey="cc" triggerVariant="field" allowedModes={DEFAULT_MODES}
        ariaContext={t('settings.newChatDefaults.title')}
        onPermissionModeChange={changePermissionMode} />
    </div>
  );
}
