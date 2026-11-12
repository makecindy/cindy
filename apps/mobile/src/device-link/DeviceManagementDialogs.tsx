import { useEffect } from 'react';
import { Alert } from 'react-native';
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
  } = manager;
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
  // 重命名在 iOS / Android 统一走自绘对话框(与任务重命名同一形态),不再用 iOS Alert.prompt。
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
