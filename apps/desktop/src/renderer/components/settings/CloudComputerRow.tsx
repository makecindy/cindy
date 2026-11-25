/**
 * CloudComputerRow —— 「远程连接 → 我的设备」里的「云主机」一行。
 * ---------------------------------------------------------------------------
 * 用户裁决(2026-11-25):云主机的添加和管理放进设备管理,侧栏机器范围菜单里的入口保留不动。
 * 开通、进度以及开关机、续费、重装和删除都在网页上完成;这里与侧栏菜单读同一份入口
 * (features/device-link/cloudComputerEntry),没有入口的账号整行不显示。开好的云主机
 * 作为普通设备出现在设备列表里。
 */

import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import {
  cloudComputerActions,
  openCloudComputerPage,
  useCloudComputerEntry,
} from '@/features/device-link/cloudComputerEntry';
import { toast } from '@/lib/toast';
import { remoteControlSettings } from './RemoteControlSection.settings-search';

export function CloudComputerRow() {
  const { t } = useTranslation();
  const entry = useCloudComputerEntry();
  if (!entry) return null;
  return (
    <SettingsCard>
      <SettingsRow
        title={t(remoteControlSettings.cloudComputer.titleKey)}
        hint={t(`settings.remoteControl.cloudComputer.hint.${entry.action}`)}
        wrap
        trailing={
          <div className="flex shrink-0 flex-wrap gap-2">
            {cloudComputerActions(entry).map((action) => (
              <Button
                key={action}
                data-setting-id={remoteControlSettings.cloudComputer.id}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  void openCloudComputerPage(entry, action).catch(() =>
                    toast.error(t('settings.remoteControl.cloudComputer.openFailed')),
                  );
                }}
              >
                {t(`settings.remoteControl.cloudComputer.actions.${action}`)}
              </Button>
            ))}
          </div>
        }
      />
    </SettingsCard>
  );
}
