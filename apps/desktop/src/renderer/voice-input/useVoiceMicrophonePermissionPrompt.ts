import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { requestRendererMicrophonePermission } from './startGuards';

/**
 * Shared microphone permission recovery dialog used by every in-app voice
 * input entry (ChatInput, AskUserQuestionPrompt, and all field inputs).
 *
 * Calls `useConfirmDialog()` (which invokes `useContext` unconditionally before
 * throwing outside a provider) inside try/catch so bare renders without
 * `ConfirmDialogProvider` degrade safely AND legacy test mocks that only stub
 * `useConfirmDialog` keep working without modification.
 */
export function useVoiceMicrophonePermissionPrompt(): () => Promise<void> {
  const { t } = useTranslation();
  let confirmDialog: ReturnType<typeof useConfirmDialog> | null = null;
  try {
    confirmDialog = useConfirmDialog();
  } catch {
    confirmDialog = null;
  }

  return useCallback(async () => {
    if (!confirmDialog) {
      toast.error(t('newChat.chatInput.voiceInput.permissionDialog.description'));
      return;
    }
    const confirmed = await confirmDialog.confirm({
      title: t('newChat.chatInput.voiceInput.permissionDialog.title'),
      description: t('newChat.chatInput.voiceInput.permissionDialog.description'),
      confirmText: t('newChat.chatInput.voiceInput.permissionDialog.confirm'),
      cancelText: t('newChat.chatInput.voiceInput.permissionDialog.cancel'),
      autoFocusConfirm: true,
    });
    if (!confirmed) return;

    const result = await requestRendererMicrophonePermission();
    if (result.ok) return;
    if (result.status === 'device-unavailable') {
      toast.error(t('settings.voiceInput.microphone.errors.deviceUnavailable'));
      return;
    }

    const settingsResult = await window.electronAPI?.voiceInput?.openMicrophoneSettings?.();
    if (settingsResult && !settingsResult.ok) {
      toast.error(settingsResult.error);
    }
  }, [confirmDialog, t]);
}
