import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { Alert, Keyboard, Pressable, StyleSheet, View } from 'react-native';
import { Stack, useIsFocused, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { homeMenuAttentionSize } from '@/platform/chrome/homeMenuIcon';
import { centeredHomeTitleWidth, HomeStackHeader } from '@/platform/chrome/HomeStackHeader';
import { simpleScreenSafeAreaEdges, usesNativeStackHeader } from '@/platform/chrome/SimpleStackHeader';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { ChevronDown, Menu } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useStableValue } from '@/utils/useStableValue';
import type { RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, navigationChrome, radius, spacing, typeScale } from '@/theme/tokens';
import { NativePullDownMenu, usesNativePullDownMenu } from '@/platform/chrome';
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
import { CLOUD_ROW_REVISION, cloudActorForRow, cloudCompanionRows } from '@/chat/cloudCompanion';
import { useCloudCompanionHome } from '@/chat/useCloudCompanion';
import { cloudCompanionRoute } from './teammateNavigation';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';

/** The teammate home is the roster: launch and every entry land on the list, never inside a chat. */
export function TeammateHomeScreen({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation();
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
  // Main computers (cloud-companions.md): only with a server that declares companionHome.
  const cloud = useCloudCompanionHome(focused);
  // One row per companion, under its main computer (a row built from the cloud when none is listed).
  const items = useMemo(() => cloud.supported ? cloudCompanionRows(roster.items, cloud.actors, cloud.deviceNames) : roster.items,
    [cloud.actors, cloud.deviceNames, cloud.supported, roster.items]);
  // A cloud companion opens its normal chat (cached when its computer is unreachable). Only a row
  // this phone knows from the cloud alone (never listed by its computer) opens the cloud conversation.
  const cloudActor = (row: HostedRemoteCollectionItem) => cloud.supported && row.item.revision === CLOUD_ROW_REVISION ? cloudActorForRow(cloud.actors, row) : null;
  const quietPresence = (row: HostedRemoteCollectionItem) => cloud.supported && !!cloudActorForRow(cloud.actors, row);
  // A companion moved by another device shows up as changed roster rows (a new row, or a cached
  // row whose computer re-listed it): re-read the main computers then, not only on focus.
  const listedCompanions = roster.items.map(row => `${row.key}\t${row.item.revision}`).sort().join('\n');
  const refreshCloud = cloud.refresh;
  useEffect(() => { if (cloud.supported) void refreshCloud(); }, [cloud.supported, listedCompanions, refreshCloud]);
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
  const nativeHeader = usesNativeStackHeader();
  const headerHeight = useHeaderHeight();
  const geometry = useAdaptiveWindow();
  // Teammates stays centered even when the task title needs to grow toward a toolbar.
  const titleWidth = centeredHomeTitleWidth(geometry.width - geometry.insets.left - geometry.insets.right, 1);
  const openMenu = useCallback(() => { Keyboard.dismiss(); setDrawer(true); }, []);
  const menuA11y = [t('devices.companions.openNavigation'),
    counts.tasks > 0 ? t('devices.companions.taskAttentionCount', { count: counts.tasks }) : ''].filter(Boolean).join(', ');
  // Roster refreshes allocate new arrays; unchanged menu contents must not close an open native menu.
  const createTargets = useStableValue(roster.createTargets, sameHosts);
  const groupCreateTargets = useStableValue(roster.groupTargets.filter(groups.isOnline), sameHosts);
  const nativeMenus = usesNativePullDownMenu();
  const modeActions = useMemo(() => [
    { id: 'tasks', title: t('devices.companions.tasks'), state: 'off' as const },
    { id: 'teammates', title: t('devices.companions.title'), state: 'on' as const },
  ], [t]);
  const selectMode = useCallback((id: string) => {
    if (id === 'tasks') void navigation.chooseMode('tasks');
  }, [navigation.chooseMode]);
  const onCreated = useCallback<ComponentProps<typeof TeammateCreateButton>['onCreated']>((host, ref) => {
    void navigation.openCreatedTeammate(host, ref);
  }, [navigation.openCreatedTeammate]);
  const onGroupCreated = useCallback<NonNullable<ComponentProps<typeof TeammateCreateButton>['onGroupCreated']>>((host, groupId) => {
    push(botGroupRoute(host, groupId));
  }, [push]);
  const afterDrawer = (action: () => void) => { pending.current = action; setDrawer(false); };
  const openDrawerPage = (href: Parameters<typeof push>[0]) => {
    pending.current = null;
    setDrawer(false);
    push(href);
  };
  const finishOverlay = () => { const action = pending.current; pending.current = null; action?.(); };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  const titleControl = useMemo(() => (
      <NativePullDownMenu actions={modeActions} onAction={selectMode} style={styles.titleMenu}>
        <Pressable
          accessibilityLabel={t('devices.companions.title')}
          accessibilityRole="button"
          onPress={nativeMenus ? undefined : openMenu}
          style={({ pressed }) => [styles.titleTrigger, pressed && styles.pressed]}
          testID="teammates.modeMenu"
        >
          <View style={styles.titleCluster}>
            <Text numberOfLines={1} style={styles.title}>{t('devices.companions.title')}</Text>
            <ChevronDown color={colors.textSecondary} size={iconSize.xs} strokeWidth={iconStroke.medium} />
          </View>
        </Pressable>
      </NativePullDownMenu>
  ), [modeActions, selectMode, styles, t, nativeMenus, openMenu, colors.textSecondary]);
  const nativeTitle = useMemo(() => <View style={[styles.nativeTitle, { width: titleWidth }]}>{titleControl}</View>, [styles, titleControl, titleWidth]);
  const createControl = useMemo(() => createTargets.length > 0 || groupCreateTargets.length > 0 ? <TeammateCreateButton appearance={nativeHeader ? 'toolbar' : 'glass'} targets={createTargets}
          groupTargets={groupCreateTargets} preferredDeviceId={navigation.lastTeammate?.deviceId}
          onCreated={onCreated} onGroupCreated={onGroupCreated} /> : null,
    [createTargets, groupCreateTargets, nativeHeader, navigation.lastTeammate?.deviceId, onCreated, onGroupCreated]);
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.screen} testID="teammates.home">
    {/* iOS: only the visible home pane registers the shared native chrome. */}
    {nativeHeader && active ? <HomeStackHeader title={nativeTitle}
      menuA11y={menuA11y} menuTestID="teammates.navigation" onOpenMenu={openMenu}
      attention={counts.tasks > 0} keepMenuTopLeft={geometry.barEdge !== 'none'}>
      {createControl}
    </HomeStackHeader> : null}
    {nativeHeader ? null : <>
    {active ? <Stack.Screen options={{ headerShown: false }} /> : null}
    <View style={styles.header}>
      <View style={styles.slot}>
        <View style={styles.navButton}>
          <HomeHeaderGlassButton accessibilityLabel={menuA11y}
            testID="teammates.navigation" onPress={openMenu}>
            <Menu color={colors.textPrimary} size={iconSize.action} strokeWidth={iconStroke.regular} />
          </HomeHeaderGlassButton>
          {/* The other side (tasks) needs a look; the drawer shows how many. Neutral, not a status color. */}
          {counts.tasks > 0 ? <View pointerEvents="none" style={styles.navDot} testID="teammates.navigation.dot" /> : null}
        </View>
      </View>
      {titleControl}
      <View style={[styles.slot, styles.slotEnd]}>
        {createControl}
      </View>
    </View>
    </>}
    <TeammateList key={searchEpoch} {...roster} items={items}
      quietPresence={quietPresence}
      topInset={nativeHeader ? headerHeight : undefined}
      notice={navigation.saveFailed ? <Text accessibilityRole="alert" style={styles.notice}>{t('devices.companions.preferenceSaveFailed')}</Text> : null} autoFocusSearch={searchEpoch > 0}
      loading={roster.items.length + groups.items.length === 0 && (roster.loading || groups.loading)}
      refreshing={roster.refreshing || groups.refreshing}
      error={groups.error ?? roster.error}
      onRefresh={() => { void roster.refresh(); void cloud.refresh(); if (groups.supported) void groups.refresh(); }}
      onSelect={(item) => {
        const actor = cloudActor(item);
        if (actor) { Keyboard.dismiss(); push(cloudCompanionRoute(item, actor.id, i18n.language)); }
        else void navigation.openTeammate(item);
      }}
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
      onOpenPlugins={() => openDrawerPage('/plugins')}
      onOpenDevices={() => openDrawerPage('/devices/manage')}
      onOpenSettings={() => openDrawerPage('/settings')}
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
  // Android fallback: iOS geometry and menu belong to HomeStackHeader.
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.md, minHeight: 48 },
  slot: { width: navigationChrome.target * 2 + spacing.xs, flexDirection: 'row' },
  slotEnd: { justifyContent: 'flex-end' },
  navButton: { width: navigationChrome.target, height: navigationChrome.target },
  navDot: { position: 'absolute', top: spacing.sm, right: spacing.sm, width: homeMenuAttentionSize, height: homeMenuAttentionSize, borderRadius: radius.pill, backgroundColor: colors.textPrimary },
  nativeTitle: { height: navigationChrome.target },
  titleMenu: { flex: 1 },
  titleTrigger: { alignItems: 'center', flex: 1, justifyContent: 'center', minHeight: navigationChrome.target, minWidth: navigationChrome.target },
  titleCluster: { maxWidth: '100%', alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  title: { flexShrink: 1, color: colors.textPrimary, fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold },
  pressed: { opacity: 0.72 },
  notice: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, padding: spacing.lg },
});

function sameHosts(a: readonly RemoteResourceHostTarget[], b: readonly RemoteResourceHostTarget[]): boolean {
  return a.length === b.length && a.every((host, index) =>
    host.deviceId === b[index].deviceId && host.deviceName === b[index].deviceName);
}
