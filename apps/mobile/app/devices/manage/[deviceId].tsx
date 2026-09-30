import { Host, List, ListItem, Text as NativeText } from '@expo/ui';
import { List as SwiftUIList } from '@expo/ui/swift-ui';
import { scrollContentBackground } from '@expo/ui/swift-ui/modifiers';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
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
import { useTheme, useThemedStyles, iconSize, iconStroke, type ThemeColors } from '@/theme';
import { Monitor } from 'lucide-react-native';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';

const DeviceInformationList = Platform.OS === 'ios' ? SwiftUIList : List;

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
  const { t } = useTranslation();
  const { mode, colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const push = useGuardedPush();
  const back = useCallback(() => goBackGuarded(router), [router]);
  const device = manager.devices.find((item) => item.deviceId === deviceId);
  const presentation = device
    ? toDeviceListItem(device, Date.now(), revoked)
    : null;
  const unknown = t('devices.management.unknown');
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
          // 与设备列表同一条相对时间规则(刚刚 / N 分钟 / N 小时 / N 天前,更早显示日期)。
          device.online
            ? t('devices.management.currentlyOnline')
            : presentation?.state === 'offline'
              ? presentation.statusDetail
              : unknown,
        ],
        ['deviceId', device.deviceId],
      ]
    : [];
  const busy = manager.loading || manager.renameSaving || manager.deleteSaving;
  return (
    <SafeAreaView
      edges={simpleScreenSafeAreaEdges()}
      style={styles.screen}
      testID="deviceInformation.screen"
    >
      <SimpleStackHeader
        right={device && presentation?.canOpen ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('remoteDesktop.title')}
            onPress={() => push({ pathname: '/devices/desktop/[deviceId]', params: { deviceId, deviceName: device.name } })}
            testID="deviceInformation.remoteDesktop"
            style={({ pressed }) => [styles.headerButton, pressed && mobileInteractionStyles.pressed]}
          >
            <Monitor color={colors.textPrimary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
          </Pressable>
        ) : undefined}
        title={device?.name ?? t('devices.management.details')}
        backTestID="deviceInformation.back"
        onBack={back}
      />
      {manager.loading && !device ? (
        <ActivityIndicator color={colors.textSecondary} style={styles.loading} />
      ) : null}
      {manager.error ? (
        <View style={styles.errorBlock}>
          <Text accessibilityRole="alert" style={styles.errorText}>
            {manager.error}
          </Text>
          <MainWindowActionButton
            action={{
              busy: manager.loading,
              label: t('devices.management.retry'),
              onPress: manager.refresh,
              testID: 'deviceInformation.retry',
            }}
            style={styles.retryButton}
          />
        </View>
      ) : null}
      {!device && !manager.loading && !manager.error ? (
        <Text style={styles.notFound}>
          {t('devices.management.notFound')}
        </Text>
      ) : null}
      {device ? (
        <Host style={styles.host} colorScheme={mode}>
          <DeviceInformationList
            {...(Platform.OS === 'ios'
              ? { modifiers: [scrollContentBackground('hidden')] }
              : {})}
          >
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
            {presentation?.canOpen ? (
              <ListItem
                onPress={() => push({ pathname: '/devices/desktop/[deviceId]', params: { deviceId, deviceName: device.name } })}
                testID="deviceInformation.remoteDesktopRow"
              >
                {t('remoteDesktop.title')}
              </ListItem>
            ) : null}
          </DeviceInformationList>
        </Host>
      ) : null}
      <DeviceManagementDialogs manager={manager} onDeleted={back} />
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  host: { backgroundColor: colors.surface, flex: 1 },
  headerButton: { alignItems: 'center', height: 44, justifyContent: 'center', width: 44 },
  loading: { paddingVertical: spacing.lg },
  errorBlock: { alignItems: 'flex-start', gap: spacing.md, padding: spacing.lg },
  // 报错说明:13/18 errorText(黑白系)。
  errorText: { color: colors.errorText, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.caption },
  retryButton: { alignSelf: 'flex-start' },
  // 成句的说明文字:13/18 textSecondary。
  notFound: { color: colors.textSecondary, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.caption, padding: spacing.lg },
});
