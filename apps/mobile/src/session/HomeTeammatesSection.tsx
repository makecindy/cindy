import { TEAMMATE_AVATAR, resolveTeammateStatus } from '@cindy/maker-shared/teammate-status';
import { TeammateStatusDot } from './TeammateStatusDot';
import { useTeammateStatus, useRosterActivities, teammateAttention } from './useTeammateStatus';
/**
 * 任务首页顶部的「伙伴」段（对照桌面 TeammatesSection.tsx 与 2026-10-24 手机「A+B 合一」定稿）：
 * 展开 = 伙伴行（CompanionListRow，默认 3 位，多了「显示全部」）；
 * 收起默认显示原有头像条；用户关闭「收起时显示头像」后只保留段头。两个选择分别按账号记住。
 * 伙伴与群聊按最近活动混排；不跟随顶栏的电脑范围筛选（与桌面一致）。手机没有单独的伙伴首页，
 * 搜索时本段只列出名字匹配的伙伴与群聊。只在首页（有共享伙伴名册）出现；没有伙伴也没有能新建的
 * 电脑时保留紧凑的邀请入口。
 * Android 把首页列表挂到根节点渲染（ResidentHomeList），所以名册与路由的导航上下文要在路由里取，
 * 再由本段重新提供。
 */
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { NavigationContext, NavigationRouteContext, useIsFocused } from 'expo-router/react-navigation';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ChevronUp, Plus, RefreshCw, UsersRound } from 'lucide-react-native';
import { resolveRemoteText } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { openManualChatInvite } from '@/chat/chatInviteIntent';
import { Text } from '@/components/AppText';
import { useDelayedConnectionNotice } from '@/components/ConnectionNoticeOverlay';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { CLOUD_ROW_REVISION, cloudActorForRow, cloudCompanionRows } from '@/chat/cloudCompanion';
import { useCloudCompanionHome } from '@/chat/useCloudCompanion';
import { isRemoteResourceUnread, remoteResourceCacheRevision, subscribeRemoteResourceCache } from '@/device-link/remoteResourceCache';
import type { HostedRemoteCollectionItem, RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useStableValue } from '@/utils/useStableValue';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { BotGroupDuoAvatar, useBotGroupIdentities } from './BotGroupAvatars';
import { OFFLINE_AVATAR_OPACITY } from './BotGroupList';
import { botGroupMemberLinks } from './botGroupRemote';
import { botGroupRoute } from './botGroupNavigation';
import { COMPANION_ROW_AVATAR_SIZE } from './CompanionListRow';
import { homeListStyles } from './HomeListVisuals';
import { useHomeRoster } from './HomeRosterContext';
import { DisclosureItem } from './listDisclosureTransition';
import { useTeammateCreateController } from './TeammateCreateController';
import { useTeammateEntries, useTeammateRowRenderer, type TeammateListEntry } from './TeammateList';
import { cloudCompanionRoute } from './teammateNavigation';
import { useTeammateNavigation } from './useTeammateNavigation';
import { getHomeViewSession, useRetainedHomeState } from './homeViewSession';

/** Desktop previews five in a 260px sidebar; three keeps the first screen of tasks on a phone. */
export const HOME_TEAMMATE_PREVIEW_LIMIT = 3;
/** The collapsed avatar uses the shared 48pt size. */
const STRIP_AVATAR_SIZE = TEAMMATE_AVATAR.strip;
/** One strip cell: the avatar plus 4pt on each side, so a 12/18 name fits under it. */
const STRIP_CELL_WIDTH = STRIP_AVATAR_SIZE + spacing.sm;
const SHOW_ALL_ROW_HEIGHT = 48;
const ADD_ROW_HEIGHT = 64;

/** Read at the route: the list may be drawn above the route (Android's resident home list). */
export function useHomeTeammatesSectionContext() {
  const navigation = useContext(NavigationContext);
  const route = useContext(NavigationRouteContext);
  const shared = useHomeRoster();
  return useMemo(() => ({ navigation, route, shared }), [navigation, route, shared]);
}

export function HomeTeammatesSection({ context, active, refreshKey, visible, query, showFooter, push, runDisclosure, prepareDisclosure }: {
  context: ReturnType<typeof useHomeTeammatesSectionContext>;
  /** The home is the screen in front. */
  active: boolean;
  /** Changes on each manual home refresh; the section then re-reads its cloud companions. */
  refreshKey: number;
  /** Hidden while filtering or browsing archived tasks; the hooks stay mounted. */
  visible: boolean;
  /** The home search text: lists every matching teammate, expanded, without create entries. */
  query: string;
  /** Full-width hairline under the section, unless the next block draws its own top line. */
  showFooter: boolean;
  /** Embedded lists close their modal drawer before dispatching the route. */
  push?: ReturnType<typeof useGuardedPush>;
  runDisclosure(apply: () => void): void;
  prepareDisclosure(): void;
}) {
  const { navigation, route, shared } = context;
  if (!shared) return null;
  return <NavigationContext.Provider value={navigation}><NavigationRouteContext.Provider value={route}>
    <SectionContent shared={shared} active={active} refreshKey={refreshKey} visible={visible} query={query} showFooter={showFooter}
      push={push} runDisclosure={runDisclosure} prepareDisclosure={prepareDisclosure} />
  </NavigationRouteContext.Provider></NavigationContext.Provider>;
}

function SectionContent({ shared, active, refreshKey, visible, query, showFooter, push: hostPush, runDisclosure, prepareDisclosure }: {
  shared: NonNullable<ReturnType<typeof useHomeRoster>>;
  active: boolean; refreshKey: number; visible: boolean; query: string; showFooter: boolean;
  push?: ReturnType<typeof useGuardedPush>;
  runDisclosure(apply: () => void): void; prepareDisclosure(): void;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const list = useThemedStyles(homeListStyles);
  const guardedPush = useGuardedPush();
  const push = hostPush ?? guardedPush;
  const navigation = useTeammateNavigation(push);
  const focused = useIsFocused() && active;
  const { roster, groups } = shared;
  const cloud = useCloudCompanionHome(focused && visible);
  // One row per companion (cloud-companions.md).
  const items = useMemo(() => cloud.supported ? cloudCompanionRows(roster.items, cloud.actors, cloud.deviceNames) : roster.items,
    [cloud.actors, cloud.deviceNames, cloud.supported, roster.items]);
  const listedCompanions = roster.items.map(row => `${row.key}\t${row.item.revision}`).sort().join('\n');
  const refreshCloud = cloud.refresh;
  useEffect(() => { if (cloud.supported) void refreshCloud(); }, [cloud.supported, listedCompanions, refreshCloud, refreshKey]);
  const cloudActor = (row: HostedRemoteCollectionItem) => cloud.supported && row.item.revision === CLOUD_ROW_REVISION ? cloudActorForRow(cloud.actors, row) : null;
  const quietPresence = (row: HostedRemoteCollectionItem) => cloud.supported && !!cloudActorForRow(cloud.actors, row);
  const showGroups = groups.supported || groups.items.length > 0;
  const search = query.trim();
  const entries = useTeammateEntries(items, showGroups ? groups.items : undefined, search);
  const openTeammate = (row: HostedRemoteCollectionItem) => {
    const actor = cloudActor(row);
    if (actor) { Keyboard.dismiss(); push(cloudCompanionRoute(row, actor.id, i18n.language)); }
    else void navigation.openTeammate(row);
  };
  const openGroup = (row: HostedRemoteCollectionItem) => { Keyboard.dismiss(); push(botGroupRoute(row.host, row.item.ref.id)); };
  const renderRow = useTeammateRowRenderer({
    items, isOnline: roster.isOnline, connectionState: roster.connectionState, quietPresence, onSelect: openTeammate,
    groups: showGroups ? { items: groups.items, isOnline: groups.isOnline, onSelect: openGroup } : undefined,
  });
  // The store answer is the account's choice; the local copy flips inside the disclosure window
  // and never carries over to another account.
  const [local, setLocal] = useState<{ owner: string; collapsed: boolean } | null>(null);
  const owner = navigation.owner;
  const stored = local?.owner === owner ? local.collapsed : navigation.teammatesCollapsed;
  // Search results are always rows; the stored fold returns with the search cleared.
  const collapsed = stored && !search;
  const headerOnly = collapsed && !navigation.showCollapsedTeammateAvatars;
  const { unread, attention } = useHeaderAttention(entries, headerOnly, roster.isOnline);
  const [showAll, setShowAll] = useRetainedHomeState(getHomeViewSession(), 'teammatesShowAll', false);
  const setTeammatesCollapsed = navigation.setTeammatesCollapsed;
  const toggleCollapsed = useCallback(() => {
    const next = !stored;
    runDisclosure(() => { setLocal({ owner, collapsed: next }); if (next) setShowAll(false); });
    void setTeammatesCollapsed(next);
  }, [stored, owner, runDisclosure, setTeammatesCollapsed, setShowAll]);
  const createTargets = useStableValue(roster.createTargets, sameHosts);
  const groupCreateTargets = useStableValue(roster.groupTargets.filter(groups.isOnline), sameHosts);
  const canCreate = createTargets.length > 0 || groupCreateTargets.length > 0;
  const { user } = useAuth();
  const canInvite = !!user;
  const showCreate = (canCreate || canInvite) && !search;
  // One controller for every trigger placement: the first teammate arriving while its form closes
  // swaps the empty row for the rows, and must not take the form or its receipt with it.
  const creator = useTeammateCreateController({ targets: createTargets, groupTargets: groupCreateTargets,
    preferredDeviceId: navigation.lastTeammate?.deviceId,
    onInvite: canInvite ? () => { Keyboard.dismiss(); openManualChatInvite(); } : undefined,
    onCreated: (host, ref) => { void navigation.openCreatedTeammate(host, ref); },
    onGroupCreated: (host, groupId) => push(botGroupRoute(host, groupId)) });
  // Keep cached rows during recovery. A lasting failure only adds a header action,
  // never a notice row that changes the list's height.
  const error = groups.error ?? roster.error ?? cloud.error;
  const errorKey = error === 'CHAT_ENDPOINT_UNAVAILABLE' ? 'groupChat.server.endpointUnavailable'
    : error === 'CHAT_LIST_FAILED' ? 'groupChat.server.loadFailed'
    : entries.length ? 'devices.companions.stale' : 'devices.resources.loadFailed';
  const retrying = roster.refreshing || groups.refreshing;
  const showError = useDelayedConnectionNotice(!!error && focused && visible && !search);
  const retry = () => {
    if (roster.error) void roster.refresh();
    if (groups.error) void groups.refresh();
    if (cloud.error) void refreshCloud();
  };
  // The invitation trigger is independent of device/roster loading; no empty body is reserved.
  const shown = visible && (search ? entries.length > 0 : canInvite || !!error || !(!entries.length && (!canCreate || roster.loading)));
  const title = t('devices.companions.title');
  const create = (trigger: (press: () => void, label: string) => ReactElement) => showCreate
    ? creator.renderTrigger(trigger(creator.press, creator.label)) : null;
  const preview = search ? entries : entries.slice(0, HOME_TEAMMATE_PREVIEW_LIMIT);
  const extra = search ? [] : entries.slice(HOME_TEAMMATE_PREVIEW_LIMIT);
  const hasMore = extra.length > 0;
  const body = shown ? <DisclosureItem clip testID="home.teammates">
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: !collapsed, disabled: !!search }} disabled={!!search}
        accessibilityLabel={[t(collapsed ? 'devices.list.a11y.expand' : 'devices.list.a11y.collapse', { title }),
          unread ? t('devices.companions.unread') : '', attention].filter(Boolean).join(', ')}
        onPress={toggleCollapsed} onPressIn={prepareDisclosure}
        style={({ pressed }) => [list.projectRow, styles.headerToggle, pressed && mobileInteractionStyles.pressed]} testID="home.teammatesHeader">
        {collapsed
          ? <ChevronRight color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
          : <ChevronDown color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />}
        <UsersRound color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.thin} />
        <Text style={[list.projectTitle, styles.headerTitle]} numberOfLines={1}>{title}</Text>
        {(collapsed && !headerOnly) || !entries.length ? null : <Text style={[list.projectCount, styles.count]} numberOfLines={1}>{entries.length}</Text>}
        {headerOnly && (unread || attention) ? <View style={[styles.unreadDot, !!attention && styles.attentionDot]} testID="home.teammatesAttention" /> : null}
      </Pressable>
      {showError ? <Pressable accessibilityRole="button" accessibilityLabel={`${t(errorKey)} ${t('devices.resources.retry')}`}
        disabled={retrying} onPress={retry} hitSlop={spacing.xs}
        style={({ pressed }) => [styles.headerAdd, pressed && mobileInteractionStyles.pressed]} testID="home.teammatesRetry">
        {retrying ? <ActivityIndicator color={colors.textTertiary} /> : <RefreshCw size={iconSize.sm} color={colors.textTertiary} strokeWidth={iconStroke.regular} />}
      </Pressable> : null}
      {/* Keep a single create entry: in the header when the body is hidden. */}
      {!headerOnly && ((collapsed && entries.length > 0) || (!entries.length && canCreate)) ? null : create((press, label) => <Pressable accessibilityRole="button" accessibilityLabel={label}
        onPress={press} hitSlop={spacing.xs} style={({ pressed }) => [styles.headerAdd, pressed && mobileInteractionStyles.pressed]} testID="home.teammatesCreate">
        <Plus color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} />
      </Pressable>)}
    </View>
    {headerOnly ? null : !entries.length ? (canCreate ? <DisclosureItem exit>{create((press, label) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={press}
      style={({ pressed }) => [styles.addRow, pressed && mobileInteractionStyles.pressed]} testID="home.teammatesAdd">
      <View style={[styles.addCircle, styles.addCircleRow]}><Plus color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} /></View>
      <Text style={styles.addText} numberOfLines={1}>{t('devices.companions.createTeammate')}</Text>
    </Pressable>)}</DisclosureItem> : null)
      : collapsed ? <DisclosureItem exit>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip} testID="home.teammatesStrip">
          {entries.map(entry => <StripCell key={`${entry.kind}:${entry.row.key}`} entry={entry}
            online={entry.kind === 'group' ? groups.isOnline(entry.row.host) : roster.isOnline(entry.row.host)}
            connected={entry.kind === 'bot' ? (roster.connectionState ? roster.connectionState(entry.row.host) : roster.isOnline(entry.row.host)) : null}
            quiet={entry.kind === 'bot' && quietPresence(entry.row)}
            onPress={() => entry.kind === 'group' ? openGroup(entry.row) : openTeammate(entry.row)} />)}
          {create((press, label) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={press}
            style={({ pressed }) => [styles.cell, pressed && mobileInteractionStyles.pressed]} testID="home.teammatesStripCreate">
            <View style={[styles.addCircle, styles.addCircleStrip]}><Plus color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} /></View>
            <View style={styles.cellNameSpace} />
          </Pressable>)}
        </ScrollView>
      </DisclosureItem>
      : <DisclosureItem exit>
        {preview.map((entry, index) => renderRow(entry, !hasMore && index === preview.length - 1))}
        {hasMore && showAll ? <DisclosureItem exit>{extra.map(entry => renderRow(entry, false))}</DisclosureItem> : null}
        {hasMore ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: showAll }}
          accessibilityLabel={showAll ? t('devices.companions.section.showLess') : t('devices.companions.section.showAllA11y', { count: entries.length })}
          onPress={() => runDisclosure(() => setShowAll(value => !value))} onPressIn={prepareDisclosure}
          style={({ pressed }) => [styles.moreRow, pressed && mobileInteractionStyles.pressed]} testID="home.teammatesShowAll">
          <Text style={styles.moreText} numberOfLines={1}>{t(showAll ? 'devices.companions.section.showLess' : 'devices.companions.section.showAll')}</Text>
          {showAll ? null : <Text style={styles.moreCount} numberOfLines={1}>{entries.length}</Text>}
          {showAll
            ? <ChevronUp color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.medium} />
            : <ChevronDown color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.medium} />}
        </Pressable> : null}
      </DisclosureItem>}
    {showFooter ? <View style={styles.footer} /> : null}
  </DisclosureItem> : null;
  return <>{body}{creator.sheets}</>;
}

/** Hidden content keeps its existing read/attention semantics without opening the section. */
function useHeaderAttention(entries: readonly TeammateListEntry[], enabled: boolean, isOnline: (host: RemoteResourceHostTarget) => boolean) {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const bots = useMemo(() => enabled ? entries.filter(entry => entry.kind === 'bot').map(entry => entry.row) : [], [enabled, entries]);
  const activities = useRosterActivities(bots);
  const readUnread = useCallback(() => enabled && entries.some(entry => {
    const { row } = entry;
    const mainUnread = isRemoteResourceUnread(user?.id ?? '', row.host.deviceId, row.item.ref.id,
      row.item.display.lastReplyAt, entry.kind === 'group' ? row.lastReplySequence : undefined);
    return entry.kind === 'group' && row.chatUnread
      ? (mainUnread ? row.chatUnread.count : row.chatUnread.threadCount) > 0 : mainUnread;
  }), [enabled, entries, user?.id]);
  const unread = useSyncExternalStore(subscribeRemoteResourceCache, readUnread);
  const attention = bots.map(row => {
    const state = teammateAttention(row, isOnline(row.host), activities, i18n.language);
    return state.waiting ? t('devices.companions.awaiting') : state.attention;
  }).find(Boolean) ?? '';
  return { unread, attention };
}

interface StripCellProps {
  entry: TeammateListEntry; online: boolean; connected: boolean | null; quiet: boolean; onPress(): void;
}

function StripCell({ entry, online, connected, quiet, onPress }: StripCellProps) {
  const { i18n } = useTranslation();
  const currentPress = useRef(onPress);
  useLayoutEffect(() => { currentPress.current = onPress; }, [onPress]);
  const press = useCallback(() => currentPress.current(), []);
  if (entry.kind === 'group') return <GroupStripCell entry={entry} online={online} connected={connected} quiet={quiet} onPress={press} />;
  const { row } = entry;
  const { display } = row.item;
  return <BotStripCell deviceId={row.host.deviceId} botId={row.item.ref.id}
    title={resolveRemoteText(display.title, i18n.language)} lastReplyAt={display.lastReplyAt}
    avatarKind={display.avatar?.kind} avatarValue={display.avatar?.value}
    avatarFallback={display.avatar?.fallbackText} avatarColor={display.avatar?.color}
    sessionId={entry.row.item.links.flatMap(link => link.rel === 'conversation' && link.target.kind === 'session' ? [link.target.sessionId] : [])[0]} activityPhase={display.teammateActivity?.phase}
    failed={display.status?.tone === 'warning' || display.status?.tone === 'critical'}
    connected={connected} quiet={quiet} working={online && !!display.generation} onPress={press} />;
}

const StripAvatar = memo(RemoteCompanionAvatar);
const BotStripCell = memo(function BotStripCell({ deviceId, botId, title, lastReplyAt,
  avatarKind, avatarValue, avatarFallback, avatarColor, connected, quiet, working, onPress, sessionId, activityPhase, failed }: {
  deviceId: string; botId: string; title: string; lastReplyAt?: number;
  sessionId?: string | null; activityPhase?: string; failed: boolean;
  avatarKind?: string; avatarValue?: string; avatarFallback?: string; avatarColor?: string;
  connected: boolean | null; quiet: boolean; working: boolean; onPress(): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { user } = useAuth();
  // Observe this companion's receipt, not the cache's global revision. Other
  // rosters and read acknowledgements need not rerender every strip avatar.
  const readUnread = useCallback(() => isRemoteResourceUnread(user?.id ?? '', deviceId, botId, lastReplyAt),
    [user?.id, deviceId, botId, lastReplyAt]);
  const unread = useSyncExternalStore(subscribeRemoteResourceCache, readUnread);
  const status = useTeammateStatus({ sessionId, deviceId, activities: activityPhase ? [{ phase: activityPhase }] : [],
    online: connected, quietOffline: quiet, working, failed, unread });
  const avatar = useMemo(() => avatarKind === undefined ? undefined : {
    kind: avatarKind, value: avatarValue ?? '', fallbackText: avatarFallback ?? '', color: avatarColor,
  }, [avatarKind, avatarValue, avatarFallback, avatarColor]);
  const dimmed = connected === false && !quiet;
  const offline = dimmed ? t('devices.resources.hostOffline') : '';
  return <Pressable accessibilityRole="button" disabled={false} accessibilityState={{ disabled: false }}
    accessibilityLabel={[title, offline, status !== 'idle' ? t(`devices.companions.avatarStatus.${status}`) : '', unread ? t('devices.companions.unread') : ''].filter(Boolean).join(', ')}
    onPress={onPress} style={({ pressed }) => [styles.cell, pressed && mobileInteractionStyles.pressed]}
    testID={`home.teammatesStrip.bot.${deviceId}.${botId}`}>
    <View style={styles.cellAvatar}>
      <View style={dimmed ? { opacity: OFFLINE_AVATAR_OPACITY } : undefined}>
        <StripAvatar avatar={avatar} deviceId={deviceId} name={title} online={connected === true} size={STRIP_AVATAR_SIZE} framed />
      </View>
      <TeammateStatusDot status={status} />
    </View>
    <Text style={[styles.cellName, unread && styles.cellNameUnread]} numberOfLines={1}>{title}</Text>
  </Pressable>;
});

function GroupStripCell({ entry, online, connected, quiet, onPress }: StripCellProps) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { user } = useAuth();
  const identityFor = useBotGroupIdentities(entry.row.host.deviceId);
  useSyncExternalStore(subscribeRemoteResourceCache, remoteResourceCacheRevision);
  const { row } = entry;
  const display = row.item.display;
  const title = resolveRemoteText(display.title, i18n.language);
  const mainUnread = isRemoteResourceUnread(user?.id ?? '', row.host.deviceId, row.item.ref.id, display.lastReplyAt,
    entry.kind === 'group' ? row.lastReplySequence : undefined);
  const unread = entry.kind === 'group' && row.chatUnread
    ? (mainUnread ? row.chatUnread.count : row.chatUnread.threadCount) > 0 : mainUnread;
  const working = online && !!display.generation;
  const status = resolveTeammateStatus({ online, unread, working, activities: [display.teammateActivity] });
  const group = entry.kind === 'group';
  const dimmed = group ? !online : connected === false && !quiet;
  const offline = dimmed ? t('devices.resources.hostOffline') : '';
  return <Pressable accessibilityRole="button" disabled={group && !online} accessibilityState={{ disabled: group && !online }}
    accessibilityLabel={[title, offline, status !== 'idle' ? t(`devices.companions.avatarStatus.${status}`) : '', unread ? t('devices.companions.unread') : ''].filter(Boolean).join(', ')}
    onPress={onPress} style={({ pressed }) => [styles.cell, pressed && mobileInteractionStyles.pressed]}
    testID={`home.teammatesStrip.${group ? 'group' : 'bot'}.${row.host.deviceId}.${row.item.ref.id}`}>
    <View style={styles.cellAvatar}>
      <View style={dimmed ? { opacity: OFFLINE_AVATAR_OPACITY } : undefined}>
        {group
          ? <BotGroupDuoAvatar deviceId={row.host.deviceId} variant="strip" online={online}
            members={botGroupMemberLinks(row.item, i18n.language).map(member =>
              identityFor(member.botId, member.label, row.groupMembers?.find(identity => identity.botId === member.botId)))} />
          : <RemoteCompanionAvatar avatar={display.avatar} deviceId={row.host.deviceId} name={title} online={connected === true} size={STRIP_AVATAR_SIZE} framed />}
      </View>
      <TeammateStatusDot status={status} />
    </View>
    <Text style={[styles.cellName, unread && styles.cellNameUnread]} numberOfLines={1}>{title}</Text>
  </Pressable>;
}

function sameHosts(a: readonly RemoteResourceHostTarget[], b: readonly RemoteResourceHostTarget[]): boolean {
  return a.length === b.length && a.every((host, index) =>
    host.deviceId === b[index].deviceId && host.deviceName === b[index].deviceName);
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface },
  headerToggle: { flex: 1 },
  headerTitle: { flex: 0, flexShrink: 1 },
  count: { flex: 1 },
  // 44 target whose glyph sits on the row's 16pt right edge (36 + hitSlop 4 each side).
  headerAdd: { width: 36, height: 36, marginRight: spacing.sm, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  strip: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  cell: { width: STRIP_CELL_WIDTH, alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xs, borderRadius: radius.container },
  cellAvatar: { width: STRIP_AVATAR_SIZE, height: STRIP_AVATAR_SIZE },
  cellName: { width: STRIP_CELL_WIDTH, color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption,
    fontWeight: fontWeight.regular, textAlign: 'center' },
  cellNameUnread: { color: colors.textPrimary, fontWeight: fontWeight.medium },
  cellNameSpace: { height: lineHeight.caption },
  unreadDot: { width: TEAMMATE_AVATAR.dot, height: TEAMMATE_AVATAR.dot, borderRadius: radius.pill, backgroundColor: colors.botUnread },
  attentionDot: { backgroundColor: colors.statusAwaiting },
  addCircle: { borderRadius: radius.pill, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  addCircleStrip: { width: STRIP_AVATAR_SIZE, height: STRIP_AVATAR_SIZE },
  addCircleRow: { width: COMPANION_ROW_AVATAR_SIZE, height: COMPANION_ROW_AVATAR_SIZE },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, height: ADD_ROW_HEIGHT, paddingLeft: spacing.lg, paddingRight: spacing.lg },
  addText: { flexShrink: 1, color: colors.textSecondary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.regular },
  // Text column of the rows above (16 inset + 44 avatar + 12 gap).
  moreRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, height: SHOW_ALL_ROW_HEIGHT,
    paddingLeft: spacing.lg + COMPANION_ROW_AVATAR_SIZE + spacing.md, paddingRight: spacing.lg },
  moreText: { flexShrink: 1, color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
  moreCount: { color: colors.textTertiary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular,
    fontVariant: ['tabular-nums'] },
  footer: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
});
