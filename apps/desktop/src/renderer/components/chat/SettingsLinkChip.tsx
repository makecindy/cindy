import { useRef } from 'react';
import { Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { SettingsNavigationTarget } from '@cindy/maker-shared/settings-navigation';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { deviceDisplayName } from '@/lib/deviceName';
import { openSettingsNavigation } from '@/lib/settingsNavigation';
import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { toast } from '@/lib/toast';
import { InlineReferenceChip } from './InlineReferenceChip';

export function SettingsLinkChip({ target }: { target: SettingsNavigationTarget }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const devices = useDeviceLinkDeviceList();
  const busy = useRef(false);
  const name = deviceDisplayName(target.deviceId, undefined, devices ?? []);
  const label = `${t(TAB_LABEL_KEY[target.tab])} · ${name}`;
  return <InlineReferenceChip label={label} icon={<Settings />} tooltip={target.query ? `${label} · ${target.query}` : label}
    onClick={() => {
      if (busy.current) return;
      busy.current = true;
      void openSettingsNavigation(target, navigate).catch(() => toast.error(t('settings.navigation.unavailable')))
        .finally(() => { busy.current = false; });
    }} />;
}
