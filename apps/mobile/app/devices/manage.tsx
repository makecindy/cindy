import { ErrorNotice } from '@/components/ErrorNotice';
import { useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { cloudComputerEntry } from '@cindy/maker-shared/device-list';
import { APP_SCHEME, getActiveMobileSessionRealm, getMobileEndpointForRealm } from '@/config/env';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
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

function CloudComputerAction() {
  const {user, apiFetch} = useAuth();
  const focused = useIsFocused();
  const {t} = useTranslation();
  const realm = getActiveMobileSessionRealm();
  const member = user?.membershipKind === 'org' ? user.id : undefined;
  const org = user?.orgId;
  const [foreground,setForeground] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => subscription.remove();
  },[]);
  const [entry,setEntry] = useState<ReturnType<typeof cloudComputerEntry>>(null);
  useEffect(() => {
    setEntry(null);
    if (!focused || !foreground || !member || !org) return;
    const owner = getMobileAuthOwner();
    const controller = new AbortController();
    const check = () => {
      if (controller.signal.aborted || !isMobileAuthOwnerCurrent(owner) || getActiveMobileSessionRealm() !== realm) throw new Error('OWNER_CHANGED');
    };
    void (async () => {
      const baseUrl = getMobileEndpointForRealm(realm,'modelAccessApiBaseUrl');
      if (!baseUrl) return;
      const value = await apiFetch<unknown>('/api/model-access/personal/cloud-computer/entry',{
        baseUrl, timeoutMs:5000, signal:controller.signal, redirect:'error', cache:'no-store', assertCurrent:check,
      });
      check();
      setEntry(cloudComputerEntry(value,member,org));
    })().catch(() => {});
    return () => controller.abort();
  },[apiFetch,focused,foreground,member,org,realm]);
  if (!focused || !foreground || !entry) return null;
  const actions = 'canAdd' in entry && entry.canAdd ? [entry.action,'addCloud' as const] : [entry.action];
  return <>{actions.map(action=><MainWindowActionButton key={action} action={{
    label:t('devices.management.' + action),
    onPress:() => {
      const url = new URL(entry.url);
      url.searchParams.set('app', APP_SCHEME);
      if (action==='addCloud') url.searchParams.set('add','1');
      void Linking.openURL(url.href).catch(() => setEntry(null));
    },
    testID:action===entry.action ? 'deviceManagement.cloudComputer' : 'deviceManagement.addCloudComputer',
  }}/>)}</>;
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
      <CloudComputerAction />
      {manager.error ? (
        <ErrorNotice accessibilityRole="alert" style={styles.errorBlock} message={manager.error}>
          <MainWindowActionButton
            action={{
              busy: manager.loading,
              label: t('devices.management.retry'),
              onPress: manager.refresh,
              testID: 'deviceManagement.retry',
            }}
            style={styles.retryButton}
          />
        </ErrorNotice>
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
  errorBlock: { marginHorizontal: spacing.lg, marginBottom: spacing.md },
  // 报错说明:13/18 errorText(黑白系)。
  errorText: { color: colors.errorText, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.caption },
  retryButton: { alignSelf: 'flex-start' },
  loading: { paddingVertical: spacing.lg },
  empty: { margin: spacing.lg, padding: spacing.lg },
});
