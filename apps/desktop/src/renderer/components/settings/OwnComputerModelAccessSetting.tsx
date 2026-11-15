import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { remoteControlSettings } from './RemoteControlSection.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

/**
 * 「让我的其他电脑用本机模型」：默认关闭，用户在这里手动打开；这是唯一的开关。与供应商分享
 * (「允许被远程调用」/「远程与分享」)无关，模型供应商页只显示状态。只在「允许同账号设备控制本机」开着时出现。
 */
export function OwnComputerModelAccessSetting() {
  const { t } = useTranslation();
  const setting = useSettingDefinition(remoteControlSettings.ownModelAccess);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);

  useEffect(() => {
    const read = window.electronAPI?.maker?.getOwnComputerModelUse;
    if (!read) return;
    let active = true;
    const current = revision.current;
    void read()
      .then((state) => {
        if (active && current === revision.current) setEnabled(state.enabled);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  if (enabled === null) return null;
  const title = setting.title;
  return (
    <section
      {...setting.anchorProps}
      aria-label={title}
      data-testid="own-computer-model-access"
      className="flex items-center justify-between gap-4 rounded-lg bg-[var(--settings-input-bg)] p-3"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-13 font-medium text-[var(--text-primary)]">{title}</p>
        <p className="text-12 text-[var(--text-tertiary)]">{setting.description}</p>
      </div>
      <Switch
        {...setting.controlProps}
        aria-label={title}
        disabled={busy}
        checked={enabled}
        onCheckedChange={(next) => {
          const previous = enabled;
          revision.current++;
          setEnabled(next);
          setBusy(true);
          void window.electronAPI.maker
            .setOwnComputerModelUse({ enabled: next })
            .catch(() => {
              setEnabled(previous);
              toast.error(t('settings.devices.ownModelAccess.writeFailed'));
            })
            .finally(() => setBusy(false));
        }}
      />
    </section>
  );
}
