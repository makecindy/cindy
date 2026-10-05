import { useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { MainWindowActionButton, MainWindowEmptyState } from '@/components/MobilePrimitives';
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
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';

/** 下拉刷新的兜底时长:刷新被跳过(如编辑中)时也要收起转圈。 */
const PULL_REFRESH_TIMEOUT_MS = 10_000;

export default function DeviceManagementScreen() {
  const { accountGeneration } = useAuth();
  return <DeviceManagementContent key={accountGeneration} />;
}

/**
 * 把 manager.refresh()(无返回值)包成「本次刷新结束才 resolve」的 Promise,
 * 供 iOS refreshable / Android RefreshControl 收起转圈。
 */
function useRefreshPromise(manager: ReturnType<typeof useDeviceManagement>) {
  const pending = useRef<{ resolve(): void; sawLoading: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const loadingRef = useRef(manager.loading);
  loadingRef.current = manager.loading;
  const finish = useCallback(() => {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    clearTimeout(current.timer);
    current.resolve();
  }, []);
  useEffect(() => {
    const current = pending.current;
    if (!current) return;
    if (manager.loading) current.sawLoading = true;
    else if (current.sawLoading) finish();
  }, [finish, manager.loading]);
  useEffect(() => finish, [finish]);
  const { refresh } = manager;
  return useCallback(() => new Promise<void>((resolve) => {
    finish();
    pending.current = { resolve, sawLoading: loadingRef.current, timer: setTimeout(finish, PULL_REFRESH_TIMEOUT_MS) };
    refresh();
  }), [finish, refresh]);
}

function DeviceManagementContent() {
  const { apiFetch } = useAuth();
  const manager = useDeviceManagement(apiFetch, useIsFocused());
  const revoked = useRevokedDevices();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const guardedPush = useGuardedPush();
  const refresh = useRefreshPromise(manager);
  const rows = toDeviceListItems(manager.devices, Date.now(), revoked);
  // 首次加载才显示整页转圈;已有列表时刷新由下拉控件自己表示。
  const initialLoading = manager.loading && rows.length === 0;
  return (
    <SafeAreaView
      edges={simpleScreenSafeAreaEdges()}
      style={styles.screen}
      testID="deviceManagement.screen"
    >
      <SimpleStackHeader
        title={t('devices.management.title')}
        backTestID="deviceManagement.back"
        onBack={() => goBackGuarded(router)}
      />
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
              testID: 'deviceManagement.retry',
            }}
            style={styles.retryButton}
          />
        </View>
      ) : null}
      {initialLoading ? (
        <ActivityIndicator color={colors.textSecondary} style={styles.loading} />
      ) : null}
      {!manager.loading && !manager.error && rows.length === 0 ? (
        <MainWindowEmptyState
          title={t('devices.presentation.deviceList.emptyTitle')}
          copy={t('devices.presentation.deviceList.emptyCopy')}
          style={styles.empty}
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
        onRefresh={refresh}
      />
      <DeviceManagementDialogs manager={manager} />
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  errorBlock: { alignItems: 'flex-start', gap: spacing.md, padding: spacing.lg },
  // 报错说明:13/18 errorText(黑白系)。
  errorText: { color: colors.errorText, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.caption },
  retryButton: { alignSelf: 'flex-start' },
  loading: { paddingVertical: spacing.lg },
  empty: { margin: spacing.lg, padding: spacing.lg },
});
