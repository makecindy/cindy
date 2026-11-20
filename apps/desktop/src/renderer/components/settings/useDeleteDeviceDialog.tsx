import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import type { DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';

type DeleteTarget = { deviceId: string; name: string };

export function useDeleteDeviceDialog(remove: DeviceLinkSettings['remove']) {
  const { t } = useTranslation();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const returnFocus = useRef<() => HTMLElement | null>(null);
  const requestDelete = (target: DeleteTarget, restoreFocus?: () => HTMLElement | null) => {
    returnFocus.current = restoreFocus ?? null;
    setDeleteTarget(target);
  };
  const [deleting, setDeleting] = useState(false);
  const deletePending = useRef(false);

  // 删除设备:**仅删除真正成功时**才连带清掉「已撤销」标记(remove 内部 catch + toast,会吞掉
  // 失败,故必须看返回值)。否则若删的是被对方撤销过的设备,切换栏的 buildSwitcherDevices 仍会拿
  // revoked id 单独撑起一颗陈旧 rejected chip,直到登出 / 停服才消失;而删除失败时清掉则会错误地
  // 抹掉一台仍存在、仍被撤销的设备的被拒状态。
  const handleDelete = async () => {
    if (!deleteTarget || deletePending.current) return;
    const { deviceId } = deleteTarget;
    deletePending.current = true;
    setDeleting(true);
    try {
      if (await remove(deviceId)) {
        revokedDevicesStore.clearRevoked(deviceId);
        setDeleteTarget(null);
      }
    } finally {
      deletePending.current = false;
      setDeleting(false);
    }
  };

  const dialog = (
    <ConfirmDialog
      open={deleteTarget !== null}
      onOpenChange={(open) => {
        if (!open && !deletePending.current) setDeleteTarget(null);
      }}
      title={t('settings.devices.deleteTitle', { name: deleteTarget?.name ?? '' })}
      description={t('settings.devices.deleteMessage')}
      confirmText={t('settings.devices.delete')}
      confirmVariant="destructive"
      restoreFocusTarget={() => returnFocus.current?.() ?? null}
      loading={deleting}
      onConfirm={() => void handleDelete()}
    />
  );

  return { requestDelete, deleting, dialog };
}
