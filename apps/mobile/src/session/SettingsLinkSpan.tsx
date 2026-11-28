import { useRef, type ComponentProps } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { navigateRemoteSettings, type SettingsNavigationTarget } from '@cindy/maker-shared/settings-navigation';

export function SettingsLinkSpan({ target, label, style, SpanText = Text }: {
  target: SettingsNavigationTarget; label: string; style?: ComponentProps<typeof Text>['style']; SpanText?: typeof Text;
}) {
  const open = useOpenSettingsLink(target);
  return <SpanText style={style} accessibilityRole="link" onPress={open}>{label}</SpanText>;
}

/** Uses the existing device lookup and guarded settings navigation. */
export function useOpenSettingsLink(target: SettingsNavigationTarget): () => void {
  const { invoke, readDeviceList } = useDeviceLink();
  const push = useGuardedPush();
  const { t } = useTranslation();
  const busy = useRef(false);
  return () => {
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      const { devices } = await readDeviceList();
      const device = devices.find(item => item.deviceId === target.deviceId);
      if (!device) throw new Error('SETTINGS_DEVICE_UNAVAILABLE');
      await navigateRemoteSettings(target, invoke, () => push({ pathname: '/devices/desktop/[deviceId]', params: { deviceId: target.deviceId, name: device.name } }));
    })().catch(() => Alert.alert(t('settings.navigation.unavailable'))).finally(() => { busy.current = false; });
  };
}
