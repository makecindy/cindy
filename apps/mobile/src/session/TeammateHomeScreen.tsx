import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Keyboard, StyleSheet, View } from 'react-native';
import { Stack, useIsFocused, useRouter } from 'expo-router';
import { Menu } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, navigationChrome, radius, spacing, typeScale } from '@/theme/tokens';
import { AccountSwitcherSheet } from './AccountSwitcherSheet';
import { botGroupRoute } from './botGroupNavigation';
import { HomeChromeDrawer } from './HomeChromeDrawer';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';
import { TeammateCreateButton } from './TeammateCreateButton';
import { TeammateList } from './TeammateList';
import { useHomeRoster, useHomeUnreadCounts } from './HomeUnreadContext';
import { useTeammateRoster } from './useTeammateRoster';
import { useBotGroupRoster } from './useBotGroupRoster';
import { useTeammateNavigation } from './useTeammateNavigation';
import { remoteSessionStore } from './remoteSessionStore';

/** The teammate home is the roster: launch and every entry land on the list, never inside a chat. */
export function TeammateHomeScreen({ active = true }: { active?: boolean }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const routeFocused = useIsFocused();
  const focused = routeFocused && active;
  const push = useGuardedPush();
  const router = useRouter();
  const navigation = useTeammateNavigation();
  const sharedRoster = useHomeRoster();
  const ownRoster = useTeammateRoster(focused && !sharedRoster);
  const ownGroups = useBotGroupRoster(ownRoster.groupTargets, focused && !sharedRoster);
  const roster = sharedRoster?.roster ?? ownRoster;
  const groups = sharedRoster?.groups ?? ownGroups;
  const counts = useHomeUnreadCounts();
  const [drawer, setDrawer] = useState(false);
  const [accounts, setAccounts] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [searchEpoch, setSearchEpoch] = useState(0);
  const pending = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const currentAccount = useRef(auth.accountGeneration); currentAccount.current = auth.accountGeneration;
  const hasRunningTasks = useSyncExternalStore(
    // 账号切换与抽屉里的退出确认都要知道是否有运行中任务;两者都关着时不订阅。
    useCallback((listener) => accounts || drawer ? remoteSessionStore.subscribe(listener) : () => {}, [accounts, drawer]),
    useCallback(() => (accounts || drawer) && remoteSessionStore.getSessions().some((session) => remoteSessionStore.isSessionRunning(session.id)), [accounts, drawer]),
  );
  const groupCreateTargets = roster.groupTargets.filter(groups.isOnline);
  const afterDrawer = (action: () => void) => { pending.current = action; setDrawer(false); };
  const finishOverlay = () => { const action = pending.current; pending.current = null; action?.(); };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  return <SafeAreaView style={styles.screen} testID="teammates.home">
    {active ? <Stack.Screen options={{ headerShown: false }} /> : null}
    <View style={styles.header}>
      <View style={styles.slot}>
        <View style={styles.navButton}>
          <HomeHeaderGlassButton accessibilityLabel={[t('devices.companions.openNavigation'),
            counts.tasks > 0 ? t('devices.companions.taskAttentionCount', { count: counts.tasks }) : ''].filter(Boolean).join(', ')}
            testID="teammates.navigation" onPress={() => { Keyboard.dismiss(); setDrawer(true); }}>
            <Menu color={colors.textPrimary} size={iconSize.action} strokeWidth={iconStroke.regular} />
          </HomeHeaderGlassButton>
          {/* The other side (tasks) needs a look; the drawer shows how many. Neutral, not a status color. */}
          {counts.tasks > 0 ? <View pointerEvents="none" style={styles.navDot} testID="teammates.navigation.dot" /> : null}
        </View>
      </View>
      <Text style={styles.title}>{t('devices.companions.title')}</Text>
      <View style={[styles.slot, styles.slotEnd]}>
        {roster.createTargets.length > 0 || groupCreateTargets.length > 0 ? <TeammateCreateButton targets={roster.createTargets}
          groupTargets={groupCreateTargets} preferredDeviceId={navigation.lastTeammate?.deviceId}
          onCreated={(host, ref) => { void navigation.openCreatedTeammate(host, ref); }}
          onGroupCreated={(host, groupId) => { push(botGroupRoute(host, groupId)); }} /> : null}
      </View>
    </View>
    {navigation.saveFailed ? <Text accessibilityRole="alert" style={styles.notice}>{t('devices.companions.preferenceSaveFailed')}</Text> : null}
    <TeammateList key={searchEpoch} {...roster} autoFocusSearch={searchEpoch > 0}
      loading={roster.items.length + groups.items.length === 0 && (roster.loading || groups.loading)}
      refreshing={roster.refreshing || groups.refreshing}
      error={groups.error ?? roster.error}
      onRefresh={() => { void roster.refresh(); if (groups.supported) void groups.refresh(); }}
      onSelect={(item) => { void navigation.openTeammate(item); }}
      groups={groups.supported || groups.items.length > 0 ? {
        items: groups.items,
        isOnline: groups.isOnline,
        onSelect: (row) => { Keyboard.dismiss(); push(botGroupRoute(row.host, row.item.ref.id)); },
      } : undefined}
      emptyAction={roster.createTargets.length > 0 ? <TeammateCreateButton appearance="cta" targets={roster.createTargets}
        preferredDeviceId={navigation.lastTeammate?.deviceId}
        onCreated={(host, ref) => { void navigation.openCreatedTeammate(host, ref); }} /> : null} />
    <HomeChromeDrawer open={drawer} user={auth.user} loggingOut={loggingOut} hasRunningTasks={hasRunningTasks} mode="teammates"
      onModeChange={(mode) => afterDrawer(() => { void navigation.setMode(mode); })}
      onClose={() => { pending.current = null; setDrawer(false); }} onClosed={finishOverlay}
      onOpenSearch={() => afterDrawer(() => setSearchEpoch((epoch) => epoch + 1))}
      onOpenPlugins={() => afterDrawer(() => push('/plugins'))}
      onOpenDevices={() => afterDrawer(() => push('/devices/manage'))}
      onOpenSettings={() => afterDrawer(() => push('/settings'))}
      onOpenAccounts={() => afterDrawer(() => setAccounts(true))}
      // 抽屉内部已 confirmLogout;成功后与设置页一致直接回登录页,不依赖外层自动跳转的时序。
      onLogout={() => {
        if (loggingOut) return;
        setLoggingOut(true);
        const account = auth.accountGeneration;
        void auth.logout().then(() => { router.replace('/login'); }, (cause) => {
          if (mounted.current && currentAccount.current === account) Alert.alert(t('devices.list.alert.actionFailed'), formatRemoteError(cause));
        }).finally(() => { if (mounted.current && currentAccount.current === account) setLoggingOut(false); });
      }} />
    <AccountSwitcherSheet visible={accounts} hasRunningTasks={hasRunningTasks} onClose={() => setAccounts(false)}
      onAddAccount={() => { pending.current = () => { void auth.beginAddAccount(); push('/add-account'); }; setAccounts(false); }}
      onClosed={finishOverlay} />
  </SafeAreaView>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  // Same chrome as the task home header: 48 tall, 16 side gutter, 92-wide slots keep the title centered.
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.md, minHeight: 48 },
  slot: { width: navigationChrome.target * 2 + spacing.xs, flexDirection: 'row' },
  slotEnd: { justifyContent: 'flex-end' },
  navButton: { width: navigationChrome.target, height: navigationChrome.target },
  navDot: { position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.textPrimary,
    borderWidth: 2, borderColor: colors.surface },
  title: { flex: 1, color: colors.textPrimary, fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold, textAlign: 'center' },
  notice: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, padding: spacing.lg },
});
