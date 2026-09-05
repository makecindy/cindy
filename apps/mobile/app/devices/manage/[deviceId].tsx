import { Host, List, ListItem, Text as NativeText } from '@expo/ui';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, Button, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { DeviceManagementDialogs } from '@/device-link/DeviceManagementDialogs';
import { DeviceInformationFields } from '@/device-link/DeviceInformationFields';
import { platformLabel, toDeviceListItem } from '@/device-link/devices';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { useDeviceManagement } from '@/device-link/useDeviceManagement';
import {
  SimpleStackHeader,
  simpleScreenSafeAreaEdges,
} from '@/platform/chrome';
import { goBackGuarded } from '@/utils/backGuard';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useTheme } from '@/theme';
import { spacing } from '@/theme/tokens';

export default function DeviceInformationScreen() {
  const { accountGeneration } = useAuth();
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  return (
    <DeviceInformationContent
      key={`${accountGeneration}:${deviceId}`}
      deviceId={deviceId}
    />
  );
}

function DeviceInformationContent({ deviceId }: { deviceId: string }) {
  const { apiFetch } = useAuth();
  const manager = useDeviceManagement(apiFetch, useIsFocused());
  const revoked = useRevokedDevices();
  const { t, i18n } = useTranslation();
  const { mode, colors } = useTheme();
  const router = useRouter();
  const push = useGuardedPush();
  const back = useCallback(() => goBackGuarded(router), [router]);
  const device = manager.devices.find((item) => item.deviceId === deviceId);
  const presentation = device
    ? toDeviceListItem(device, Date.now(), revoked)
    : null;
  const unknown = t('devices.management.unknown');
  const seen = device?.lastSeenAt ? new Date(device.lastSeenAt) : null;
  const fields = device
    ? [
        ['name', device.name],
        ['status', presentation?.statusLabel ?? unknown],
        [
          'platform',
          device.platform ? platformLabel(device.platform) : unknown,
        ],
        ['model', device.deviceInfo?.modelLabel ?? unknown],
        ['systemVersion', device.deviceInfo?.osVersion ?? unknown],
        ['appVersion', device.appVersion ?? unknown],
        ['cpu', device.deviceInfo?.cpuLabel ?? unknown],
        [
          'memory',
          device.deviceInfo?.memoryGb
            ? `${device.deviceInfo.memoryGb} GB`
            : unknown,
        ],
        [
          'lastSeen',
          device.online
            ? t('devices.management.currentlyOnline')
            : seen && Number.isFinite(seen.getTime())
              ? seen.toLocaleString(i18n.language)
              : unknown,
        ],
        ['deviceId', device.deviceId],
      ]
    : [];
  const busy = manager.loading || manager.renameSaving || manager.deleteSaving;
  return (
    <SafeAreaView
      edges={simpleScreenSafeAreaEdges()}
      style={{ flex: 1, backgroundColor: colors.surface }}
      testID="deviceInformation.screen"
    >
      <SimpleStackHeader
        title={device?.name ?? t('devices.management.details')}
        backTestID="deviceInformation.back"
        onBack={back}
      />
      {manager.loading ? (
        <ActivityIndicator color={colors.textSecondary} />
      ) : null}
      {manager.error ? (
        <View style={{ padding: spacing.lg }}>
          <Text accessibilityRole="alert" style={{ color: colors.errorText }}>
            {manager.error}
          </Text>
          <Button
            title={t('devices.management.retry')}
            onPress={manager.refresh}
          />
        </View>
      ) : null}
      {!device && !manager.loading && !manager.error ? (
        <Text style={{ color: colors.textSecondary, padding: spacing.lg }}>
          {t('devices.management.notFound')}
        </Text>
      ) : null}
      {device ? (
        <Host style={{ flex: 1 }} colorScheme={mode}>
          <List>
            <DeviceInformationFields fields={fields} />
            <ListItem
              onPress={() => {
                if (!busy) manager.openRename(device);
              }}
              testID="deviceInformation.rename"
            >
              {t('devices.list.menu.renameDevice')}
            </ListItem>
            <ListItem
              onPress={() => {
                if (!busy) manager.openDelete(device);
              }}
              testID="deviceInformation.delete"
            >
              <NativeText textStyle={{ color: colors.destructive }}>
                {t('devices.management.deleteDevice')}
              </NativeText>
            </ListItem>
            {presentation?.canOpen ? (
              <ListItem
                onPress={() =>
                  push({
                    pathname: '/devices/[deviceId]',
                    params: { deviceId, name: device.name },
                  })
                }
                testID="deviceInformation.tasks"
              >
                {t('devices.list.menu.showDeviceTasks')}
              </ListItem>
            ) : null}
          </List>
        </Host>
      ) : null}
      <DeviceManagementDialogs manager={manager} onDeleted={back} />
    </SafeAreaView>
  );
}
