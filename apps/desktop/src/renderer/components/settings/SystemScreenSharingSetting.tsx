import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import type { SystemScreenSharingMode } from '../../../shared/remoteDesktopViewer';
import { toast } from '@/lib/toast';
import { remoteControlSettings } from './RemoteControlSection.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

/** macOS controller preference: open other Macs in system Screen Sharing when reachable. */
export function SystemScreenSharingSetting() {
  const setting = useSettingDefinition(remoteControlSettings.systemScreenSharing);
  const modeSetting = useSettingDefinition(remoteControlSettings.systemScreenSharingMode);
  const { t } = useTranslation();
  const api = window.electronAPI?.remoteDesktop;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<SystemScreenSharingMode>('high');
  useEffect(() => {
    if (!api?.systemSharing) return;
    let active = true;
    void api
      .systemSharing()
      .then((value) => {
        if (active) {
          setEnabled(value.enabled);
          setMode(value.mode);
        }
      })
      .catch(() => {
        if (active) setEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  if (window.electronAPI?.platform !== 'darwin' || !api?.systemSharing) return null;
  return (
    <div className="flex flex-col gap-3">
      <SettingsCard>
        <SettingsRow
          {...setting.anchorProps}
          title={setting.title}
          hint={setting.description}
          trailing={
            <Switch
              {...setting.controlProps}
              aria-label={t('settings.remoteControl.systemSharing.toggleAria')}
              checked={enabled === true}
              disabled={busy || enabled === null}
              onCheckedChange={(next) => {
                setBusy(true);
                void api
                  .setSystemSharing(next)
                  .then((value) => setEnabled(value.enabled))
                  .catch(() => toast.error(t('settings.remoteControl.systemSharing.saveFailed')))
                  .finally(() => setBusy(false));
              }}
            />
          }
        />
        <SettingsRow
          {...modeSetting.anchorProps}
          title={modeSetting.title}
          hint={modeSetting.description}
          trailing={
            <Select
              {...modeSetting.controlProps}
              label={modeSetting.title}
              value={mode}
              disabled={busy || enabled !== true}
              options={[
                { value: 'high', label: t('settings.remoteControl.systemSharing.modeHigh') },
                {
                  value: 'standard',
                  label: t('settings.remoteControl.systemSharing.modeStandard'),
                },
              ]}
              onValueChange={(next) => {
                if (next !== 'high' && next !== 'standard') return;
                setBusy(true);
                void api
                  .setSystemSharingMode(next)
                  .then((value) => setMode(value.mode))
                  .catch(() => toast.error(t('settings.remoteControl.systemSharing.saveFailed')))
                  .finally(() => setBusy(false));
              }}
            />
          }
        />
      </SettingsCard>
      {/* Screen Sharing is Apple's session: Cindy's viewer safeguards do not apply to it. */}
      <p className="flex items-start gap-2 text-12 leading-[1.5] text-[var(--text-tertiary)]">
        <Info aria-hidden size={13} className="mt-0.5 shrink-0" />
        {t('settings.remoteControl.systemSharing.limits')}
      </p>
    </div>
  );
}
