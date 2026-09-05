import { useIsFocused, useRouter } from 'expo-router';
import { ActivityIndicator, Button, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { MainWindowEmptyState } from '@/components/MobilePrimitives';
import { toDeviceListItems } from '@/device-link/devices';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { useDeviceManagement } from '@/device-link/useDeviceManagement';
import { DeviceManagementList } from '@/device-link/DeviceManagementList';
import { DeviceManagementDialogs } from '@/device-link/DeviceManagementDialogs';
import {
  SimpleStackHeader,
  simpleScreenSafeAreaEdges,
} from '@/platform/chrome';
import { goBackGuarded } from '@/utils/backGuard';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useTheme } from '@/theme';
import { spacing } from '@/theme/tokens';

export default function DeviceManagementScreen() {
  const { accountGeneration } = useAuth();
  return <DeviceManagementContent key={accountGeneration} />;
}

function DeviceManagementContent() {
  const { apiFetch } = useAuth();
  const manager = useDeviceManagement(apiFetch, useIsFocused());
  const revoked = useRevokedDevices();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const guardedPush = useGuardedPush();
  const rows = toDeviceListItems(manager.devices, Date.now(), revoked);
  return (
    <SafeAreaView
      edges={simpleScreenSafeAreaEdges()}
      style={{ flex: 1, backgroundColor: colors.surface }}
      testID="deviceManagement.screen"
    >
      <SimpleStackHeader
        title={t('devices.management.title')}
        backTestID="deviceManagement.back"
        onBack={() => goBackGuarded(router)}
      />
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
      {manager.loading ? (
        <ActivityIndicator color={colors.textSecondary} />
      ) : null}
      {!manager.loading && !manager.error && rows.length === 0 ? (
        <MainWindowEmptyState
          title={t('devices.presentation.deviceList.emptyTitle')}
          copy={t('devices.presentation.deviceList.emptyCopy')}
        />
      ) : null}
      <DeviceManagementList
        rows={rows}
        busy={manager.loading || manager.renameSaving || manager.deleteSaving}
        onOpen={(device) =>
          guardedPush({
            pathname: '/devices/manage/[deviceId]',
            params: { deviceId: device.deviceId },
          })
        }
        onRename={manager.openRename}
        onDelete={manager.openDelete}
      />
      <DeviceManagementDialogs manager={manager} />
    </SafeAreaView>
  );
}
