/**
 * 另一台电脑在用本机设备身份时的提示(判定见 main/device-link/deviceIdentityConflict.ts)。
 *
 * - DeviceIdentityConflictNotice：主窗口常驻，确认冲突时弹一张不会自动消失的提醒卡，
 *   带用户去「设置 → 远程控制 → 我的设备」；冲突解除时收起。
 * - DeviceIdentityConflictRow：「我的设备」本机卡片里的说明与「给这台电脑换一个新身份」。
 * 换身份只在用户确认后发生，没有冲突的用户看不到任何变化。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import type { DeviceLinkIdentityConflict } from '../../../shared/deviceLinkIpc';

export function useDeviceIdentityConflict(): DeviceLinkIdentityConflict | null {
  const [conflict, setConflict] = useState<DeviceLinkIdentityConflict | null>(null);
  useEffect(() => {
    let disposed = false;
    let pushed = false;
    const api = window.electronAPI?.deviceLink;
    const off = api?.onIdentityConflict?.((payload) => {
      pushed = true;
      setConflict(payload.conflict ?? null);
    });
    void Promise.resolve(api?.getState?.())
      .then((state) => {
        if (!disposed && !pushed) setConflict(state?.identityConflict ?? null);
      })
      .catch(() => { /* 读不到状态时等下一次推送 */ });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  return conflict;
}

export function DeviceIdentityConflictNotice() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const conflict = useDeviceIdentityConflict();
  const shownFor = useRef<number | null>(null);
  const toastId = useRef<string | null>(null);

  useEffect(() => {
    if (!conflict) {
      if (toastId.current) toast.dismiss(toastId.current);
      toastId.current = null;
      shownFor.current = null;
      return;
    }
    // 同一次冲突只提醒一次；用户点了「稍后」不再打扰，设置页里仍能看到。
    if (shownFor.current === conflict.detectedAt) return;
    shownFor.current = conflict.detectedAt;
    toastId.current = toast.warning(t('settings.devices.identityConflict.toastBody'), {
      title: t('settings.devices.identityConflict.toastTitle', { name: conflict.otherDeviceName }),
      duration: 0,
      dismissLabel: t('settings.devices.identityConflict.toastDismiss'),
      action: {
        label: t('settings.devices.identityConflict.toastAction'),
        onClick: () => navigate('/settings?tab=remote-control&section=devices'),
      },
      onClose: () => { toastId.current = null; },
    });
  }, [conflict, navigate, t]);

  useEffect(() => () => {
    if (toastId.current) toast.dismiss(toastId.current);
  }, []);

  return null;
}

/** 本机卡片里的冲突说明；conflict 由卡片读取，同一份状态也用来收起重复的连接问题提示。 */
export function DeviceIdentityConflictRow({ conflict }: { conflict: DeviceLinkIdentityConflict | null }) {
  return conflict ? <ConfirmedDeviceIdentityConflictRow conflict={conflict} /> : null;
}

function ConfirmedDeviceIdentityConflictRow({ conflict }: { conflict: DeviceLinkIdentityConflict }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [replacing, setReplacing] = useState(false);

  const replace = useCallback(async (name: string) => {
    const ok = await confirm({
      title: t('settings.devices.identityConflict.confirmTitle'),
      content: (
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-13 text-[var(--confirm-desc)]">
          <li>{t('settings.devices.identityConflict.confirmRestart')}</li>
          <li>{t('settings.devices.identityConflict.confirmNewDevice')}</li>
          <li>{t('settings.devices.identityConflict.confirmKeptByOther', { name })}</li>
          <li>{t('settings.devices.identityConflict.confirmOtherUnaffected', { name })}</li>
        </ul>
      ),
      confirmText: t('settings.devices.identityConflict.confirmAction'),
    });
    if (!ok) return;
    setReplacing(true);
    try {
      await window.electronAPI.deviceLink.replaceDeviceIdentity();
      // 成功后应用自行重启；按钮保持忙碌，避免重复点击。
    } catch {
      setReplacing(false);
      toast.error(t('settings.devices.identityConflict.failed'));
    }
  }, [confirm, t]);

  const name = conflict.otherDeviceName;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">
      <span className="text-12 text-[var(--error-fg)]">
        {t('settings.devices.identityConflict.notice', { name })}
      </span>
      {conflict.replaceBlockedBy === 'self-hosted-relay' ? (
        <span className="text-11 text-[var(--text-tertiary)]">
          {t('settings.devices.identityConflict.blockedSelfHostedRelay', { name })}
        </span>
      ) : (
        <div>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            loading={replacing}
            disabled={replacing}
            onClick={() => void replace(name)}
          >
            {t('settings.devices.identityConflict.replace')}
          </Button>
        </div>
      )}
    </div>
  );
}
