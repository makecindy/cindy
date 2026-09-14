import { useEffect, useRef } from 'react';
import { Alert, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RenameDeviceModal } from '@/session/RenameDeviceModal';
import type { useDeviceManagement } from './useDeviceManagement';

export function DeviceManagementDialogs({
  manager,
  onDeleted,
}: {
  manager: ReturnType<typeof useDeviceManagement>;
  onDeleted?(): void;
}) {
  const { t } = useTranslation();
  const {
    deleteTarget,
    deleteError,
    deleteSaving,
    closeDelete,
    confirmDelete,
    renameTarget,
    renameSaving,
    renameError,
  } = manager;
  const latest = useRef(manager);
  latest.current = manager;
  useEffect(() => {
    if (Platform.OS !== 'ios' || !renameTarget || renameSaving) return;
    Alert.prompt(
      t('devices.list.renameDevice.title'),
      renameError?.message,
      [
        {
          text: t('devices.common.cancel'),
          style: 'cancel',
          onPress: () => latest.current.closeRename(),
        },
        {
          text: t('devices.common.save'),
          onPress: (value?: string) => {
            const name = value?.trim() ?? '';
            if (!name) {
              latest.current.closeRename();
              return;
            }
            latest.current.setRenameDraft(name);
            void latest.current.confirmRename(name);
          },
        },
      ],
      'plain-text',
      latest.current.renameDraft,
    );
  }, [renameTarget, renameSaving, renameError, t]);
  useEffect(() => {
    if (!deleteTarget || deleteSaving) return;
    Alert.alert(
      t('devices.management.deleteTitle', { name: deleteTarget.name }),
      deleteError ?? t('devices.management.deleteMessage'),
      [
        {
          text: t('devices.common.cancel'),
          style: 'cancel',
          onPress: closeDelete,
        },
        {
          text: t('devices.management.deleteDevice'),
          style: 'destructive',
          onPress: () => {
            void confirmDelete().then((deleted) => {
              if (deleted) onDeleted?.();
            });
          },
        },
      ],
      { cancelable: true, onDismiss: closeDelete },
    );
  }, [
    deleteTarget,
    deleteError,
    deleteSaving,
    closeDelete,
    confirmDelete,
    onDeleted,
    t,
  ]);
  if (Platform.OS === 'ios') return null;
  return (
    <RenameDeviceModal
      draft={manager.renameDraft}
      error={manager.renameError?.message ?? null}
      onCancel={manager.closeRename}
      onChangeDraft={manager.setRenameDraft}
      onConfirm={() => void manager.confirmRename()}
      saving={manager.renameSaving}
      visible={manager.renameTarget !== null}
    />
  );
}
