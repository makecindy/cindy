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
import { Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { NavigationContext, NavigationRouteContext, useIsFocused } from 'expo-router/react-navigation';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ChevronUp, Link2, Plus, RefreshCw, UserPlus, UsersRound } from 'lucide-react-native';
import { resolveRemoteText } from '@cindy/device-link';
import { BUDDY_SET_LIMIT } from '@cindy/maker-shared/buddy-sets';
import { useAuth } from '@/auth/AuthContext';
import { openManualChatInvite } from '@/chat/chatInviteIntent';
import { Text } from '@/components/AppText';
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
import { homeListStyles, SESSION_ROW_LONG_PRESS_MS } from './HomeListVisuals';
import { HomeSectionOptionsSheet, type HomeSectionOptionItem, type HomeSectionOptionsGroup } from './HomeSectionOptionsSheet';
import { useHomeRoster } from './HomeRosterContext';
import { DisclosureItem } from './listDisclosureTransition';
import { MountOnFirstOpen } from './MountOnFirstOpen';
import { SwipeableSectionHeader } from './SwipeableSectionHeader';
import type { SwipeRowRegistry } from './swipeRowRegistry';
import { useTeammateCreateController } from './TeammateCreateController';
import { useTeammateEntries, useTeammateRowRenderer, type TeammateListEntry } from './TeammateList';
import { useBuddySets } from './useBuddySets';
import { BuddySetGroups } from './BuddySetGroups';
import { BuddySetSheet } from './BuddySetSheet';
import { mobileBuddySetCopy, type BuddySetCandidate } from './buddySetCopy';
import { cloudCompanionRoute } from './teammateNavigation';
import { useTeammateNavigation } from './useTeammateNavigation';
import { getHomeViewSession, useRetainedHomeState } from './homeViewSession';

/** Desktop previews five in a 260px sidebar; three keeps the first screen of tasks on a phone. */
export const HOME_TEAMMATE_PREVIEW_LIMIT = 3;
/** A smaller portrait inside a full touch target, with room for the corner dot. */
const STRIP_AVATAR_SIZE = TEAMMATE_AVATAR.strip;
const STRIP_CELL_WIDTH = TEAMMATE_AVATAR.stripTarget;
const SHOW_ALL_ROW_HEIGHT = 48;
const ADD_ROW_HEIGHT = 64;

/** Read at the route: the list may be drawn above the route (Android's resident home list). */
export function useHomeTeammatesSectionContext() {
  const navigation = useContext(NavigationContext);
  const route = useContext(NavigationRouteContext);
  const shared = useHomeRoster();
  return useMemo(() => ({ navigation, route, shared }), [navigation, route, shared]);
}

export function HomeTeammatesSection({ context, active, refreshKey, visible, query, showCollapsedAvatars, onChangeShowCollapsedAvatars, showFooter, push, swipeRegistry, runDisclosure, prepareDisclosure }: {
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
  showCollapsedAvatars: boolean;
  onChangeShowCollapsedAvatars?(value: boolean): void;
  /** Embedded lists close their modal drawer before dispatching the route. */
  push?: ReturnType<typeof useGuardedPush>;
  swipeRegistry?: SwipeRowRegistry;
  runDisclosure(apply: () => void): void;
  prepareDisclosure(): void;
}) {
  const { navigation, route, shared } = context;
  if (!shared) return null;
  return <NavigationContext.Provider value={navigation}><NavigationRouteContext.Provider value={route}>
    <SectionContent shared={shared} active={active} refreshKey={refreshKey} visible={visible} query={query} showCollapsedAvatars={showCollapsedAvatars} onChangeShowCollapsedAvatars={onChangeShowCollapsedAvatars} showFooter={showFooter}
      push={push} swipeRegistry={swipeRegistry} runDisclosure={runDisclosure} prepareDisclosure={prepareDisclosure} />
  </NavigationRouteContext.Provider></NavigationContext.Provider>;
}

function SectionContent({ shared, active, refreshKey, visible, query, showCollapsedAvatars, onChangeShowCollapsedAvatars, showFooter, push: hostPush, swipeRegistry, runDisclosure, prepareDisclosure }: {
  shared: NonNullable<ReturnType<typeof useHomeRoster>>;
  active: boolean; refreshKey: number; visible: boolean; query: string; showFooter: boolean; showCollapsedAvatars: boolean;
  onChangeShowCollapsedAvatars?(value: boolean): void;
  push?: ReturnType<typeof useGuardedPush>;
  swipeRegistry?: SwipeRowRegistry;
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
  // 「伙伴集」:纯本机、按账号的展示容器,只收伙伴私聊行。
  const [buddySets, updateBuddySets, buddySetsStatus, retryBuddySets, buddySetsSaveFailed, retrySaveBuddySets] = useBuddySets(navigation.owner);
  const buddySetCopy = mobileBuddySetCopy(t);
  const [buddySetEdit, setBuddySetEdit] = useState<{ visible: boolean; buddySetId: string | null }>({ visible: false, buddySetId: null });
  const buddySetCandidates = useMemo<BuddySetCandidate[]>(() => entries
    .filter((entry): entry is TeammateListEntry & { kind: 'bot' } => entry.kind === 'bot')
    .map((entry) => ({
      id: `bot:${entry.row.key}`,
      name: resolveRemoteText(entry.row.item.display.title, i18n.language),
    })), [entries, i18n.language]);
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
  const headerOnly = collapsed && !showCollapsedAvatars;
  // Local buddy-set failures must stay actionable even when the body is folded:
  // the row retries below are hidden by the headerOnly branch.
  const hasBuddySets = buddySets.sets.length > 0;
  const buddySetsFailed = buddySetsStatus === 'error';
  const buddySetsFailure = buddySetsSaveFailed
    ? { label: buddySetCopy.saveFailed, retry: retrySaveBuddySets }
    : buddySetsFailed
      ? { label: t('devices.resources.loadFailed'), retry: retryBuddySets }
      : null;
  const { unread, attention } = useHeaderAttention(entries, headerOnly, roster.isOnline);
  const [showAll, setShowAll] = useRetainedHomeState(getHomeViewSession(), 'teammatesShowAll', false);
  const setTeammatesCollapsed = navigation.setTeammatesCollapsed;
  const toggleCollapsed = useCallback(() => {
    if (swipeRegistry?.closeOpenRow()) return;
    const next = !stored;
    runDisclosure(() => { setLocal({ owner, collapsed: next }); if (next) setShowAll(false); });
    void setTeammatesCollapsed(next);
  }, [stored, owner, runDisclosure, setTeammatesCollapsed, setShowAll, swipeRegistry]);
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
    onNewBuddySet: buddySetsStatus === 'ready' && buddySets.sets.length < BUDDY_SET_LIMIT
      ? () => setBuddySetEdit({ visible: true, buddySetId: null }) : undefined,
    onCreated: (host, ref) => { void navigation.openCreatedTeammate(host, ref); },
    onGroupCreated: (host, groupId) => push(botGroupRoute(host, groupId)) });
  // Keep cached rows during recovery. A lasting failure is surfaced inside the header's
  // options sheet (retry action) without inserting a notice row or adding permanent header chrome.
  const error = groups.error ?? roster.error ?? cloud.error;
  const errorKey = error === 'CHAT_ENDPOINT_UNAVAILABLE' ? 'groupChat.server.endpointUnavailable'
    : error === 'CHAT_LIST_FAILED' ? 'groupChat.server.loadFailed'
    : entries.length ? 'devices.companions.stale' : 'devices.resources.loadFailed';
  const retrying = roster.refreshing || groups.refreshing;
  const retry = useCallback(() => {
    if (roster.error) void roster.refresh();
    if (groups.error) void groups.refresh();
    if (cloud.error) void refreshCloud();
  }, [cloud.error, groups, refreshCloud, roster]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const pendingOptionsAction = useRef<(() => void) | null>(null);
  const openOptions = useCallback(() => {
    swipeRegistry?.closeOpenRow();
    setOptionsOpen(true);
  }, [swipeRegistry]);
  const closeOptions = useCallback(() => {
    setOptionsOpen(false);
  }, []);
  const handleOptionsClosed = useCallback(() => {
    const action = pendingOptionsAction.current;
    pendingOptionsAction.current = null;
    action?.();
  }, []);
  const runAfterOptionsClose = useCallback((action: () => void) => {
    pendingOptionsAction.current = action;
    setOptionsOpen(false);
  }, []);
  const botTargets = creator.orderedTargets ?? [];
  const groupTargetsList = creator.orderedGroupTargets ?? [];
  const optionSections = useMemo<readonly HomeSectionOptionsGroup[]>(() => {
    const sections: HomeSectionOptionsGroup[] = [];
    if (showCreate) {
      const createItems: HomeSectionOptionItem[] = [];
      for (const host of botTargets) {
        createItems.push({
          id: `bot:${host.deviceId}`,
          title: creator.botLabel ?? t('devices.companions.createTeammate'),
          subtitle: botTargets.length > 1 ? host.deviceName : undefined,
          sfSymbol: 'person.crop.circle.badge.plus',
          icon: UserPlus,
          testID: `home.teammatesOptions.createBot.${host.deviceId}`,
          onPress: () => runAfterOptionsClose(() => creator.startBot?.(host.deviceId)),
        });
      }
      for (const host of groupTargetsList) {
        createItems.push({
          id: `group:${host.deviceId}`,
          title: creator.groupLabel ?? t('groupChat.create.title'),
          subtitle: groupTargetsList.length > 1 ? host.deviceName : undefined,
          sfSymbol: 'person.2',
          icon: UsersRound,
          testID: `home.teammatesOptions.createGroup.${host.deviceId}`,
          onPress: () => runAfterOptionsClose(() => creator.startGroup?.(host.deviceId)),
        });
      }
      if (canInvite) {
        createItems.push({
          id: 'invite',
          title: t('groupChat.invitation.entry'),
          sfSymbol: 'link',
          icon: Link2,
          testID: 'home.teammatesOptions.invite',
          onPress: () => runAfterOptionsClose(() => { Keyboard.dismiss(); openManualChatInvite(); }),
        });
      }
      if (buddySetsStatus === 'ready' && buddySets.sets.length < BUDDY_SET_LIMIT) {
        createItems.push({
          id: 'newBuddySet',
          title: buddySetCopy.new,
          sfSymbol: 'folder.badge.plus',
          icon: UsersRound,
          testID: 'home.teammatesOptions.newBuddySet',
          onPress: () => runAfterOptionsClose(() => setBuddySetEdit({ visible: true, buddySetId: null })),
        });
      }
      if (createItems.length > 0) {
        sections.push({
          id: 'create',
          title: t('devices.companions.createMenu'),
          items: createItems,
        });
      }
    }
    if (onChangeShowCollapsedAvatars) {
      sections.push({
        id: 'display',
        title: t('devices.list.menu.displayHeading'),
        items: [{
          id: 'showCollapsedAvatars',
          title: t('devices.list.menu.showCollapsedTeammateAvatars'),
          selected: showCollapsedAvatars,
          testID: 'home.teammatesOptions.showCollapsedAvatars',
          onPress: () => onChangeShowCollapsedAvatars(!showCollapsedAvatars),
        }],
      });
    }
    if (error) {
      sections.push({
        id: 'retry',
        items: [{
          id: 'retry',
          title: t('devices.resources.retry'),
          subtitle: t(errorKey),
          sfSymbol: 'arrow.clockwise',
          icon: RefreshCw,
          disabled: retrying,
          testID: 'home.teammatesOptions.retry',
          onPress: () => runAfterOptionsClose(retry),
        }],
      });
    }
    return sections;
  }, [
    botTargets,
    buddySetCopy.new,
    buddySets.sets.length,
    buddySetsStatus,
    canInvite,
    creator.botLabel,
    creator.groupLabel,
    creator.startBot,
    creator.startGroup,
    error,
    errorKey,
    groupTargetsList,
    onChangeShowCollapsedAvatars,
    retry,
    retrying,
    runAfterOptionsClose,
    showCollapsedAvatars,
    showCreate,
    t,
  ]);
  const hasOptions = !search && optionSections.length > 0;
  // The invitation trigger is independent of device/roster loading; no empty body is reserved.
  // Sets are visible even with an empty roster; a failed local read offers a retry.
  const shown = visible && (search ? entries.length > 0
    : hasBuddySets || buddySetsFailed || buddySetsSaveFailed || canInvite || !!error || !(!entries.length && (!canCreate || roster.loading)));
  const title = t('devices.companions.title');
  const create = (trigger: (press: () => void, label: string) => ReactElement) => showCreate
    ? creator.renderTrigger(trigger(creator.press, creator.label)) : null;
  const preview = search ? entries : entries.slice(0, HOME_TEAMMATE_PREVIEW_LIMIT);
  const extra = search ? [] : entries.slice(HOME_TEAMMATE_PREVIEW_LIMIT);
  const hasMore = extra.length > 0;
  const body = shown ? <DisclosureItem clip testID="home.teammates">
    <SwipeableSectionHeader
      rowKey="teammates:header"
      registry={swipeRegistry}
      enabled={hasOptions}
      onOptions={openOptions}
      testID="home.teammatesHeader.swipe"
      actionTestID="home.teammatesSettings"
    >
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: !collapsed, disabled: !!search }} disabled={!!search}
          accessibilityActions={hasOptions ? [{ name: 'options', label: t('session.row.moreOptions') }] : undefined}
          onAccessibilityAction={hasOptions ? (event) => {
            if (event.nativeEvent.actionName === 'options') openOptions();
          } : undefined}
          accessibilityLabel={[t(collapsed ? 'devices.list.a11y.expand' : 'devices.list.a11y.collapse', { title }),
            unread ? t('devices.companions.unread') : '', attention, buddySetsFailure?.label].filter(Boolean).join(', ')}
          delayLongPress={SESSION_ROW_LONG_PRESS_MS}
          onLongPress={hasOptions ? openOptions : undefined}
          onPress={toggleCollapsed} onPressIn={prepareDisclosure}
          style={({ pressed }) => [list.projectRow, styles.headerToggle, pressed && mobileInteractionStyles.pressed]} testID="home.teammatesHeader">
          {collapsed
            ? <ChevronRight color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
            : <ChevronDown color={colors.textSecondary} size={iconSize.xl} strokeWidth={iconStroke.regular} />}
          <Text style={list.projectTitle} numberOfLines={1}>{title}</Text>
          {(collapsed && !headerOnly) || !entries.length ? null : <Text style={list.projectCount} numberOfLines={1}>{entries.length}</Text>}
          {headerOnly && (unread || attention) ? <View style={[styles.unreadDot, !!attention && styles.attentionDot]} testID="home.teammatesAttention" /> : null}
        </Pressable>
        {headerOnly && buddySetsFailure ? <Pressable accessibilityRole="button"
          accessibilityLabel={`${buddySetsFailure.label} ${t('devices.resources.retry')}`}
          onPress={buddySetsFailure.retry} hitSlop={spacing.xs}
          style={({ pressed }) => [styles.headerAdd, pressed && mobileInteractionStyles.pressed]}
          testID="home.buddySetsHeaderRetry">
          <RefreshCw size={iconSize.sm} color={colors.textTertiary} strokeWidth={iconStroke.regular} />
        </Pressable> : null}
      </View>
    </SwipeableSectionHeader>
    {headerOnly ? null : <>
      {buddySetsFailed ? <Pressable accessibilityRole="button"
        accessibilityLabel={`${t('devices.resources.loadFailed')} ${t('devices.resources.retry')}`}
        onPress={retryBuddySets} hitSlop={spacing.xs} testID="home.buddySetsRetry"
        style={({ pressed }) => [styles.moreRow, pressed && mobileInteractionStyles.pressed]}>
        <RefreshCw size={iconSize.sm} color={colors.textSecondary} strokeWidth={iconStroke.regular} />
        <Text style={styles.moreText} numberOfLines={1}>{t('devices.resources.retry')}</Text>
      </Pressable> : null}
      {/* A failed write must never look saved; offer an explicit retry row. */}
      {buddySetsSaveFailed ? <Pressable accessibilityRole="button"
        accessibilityLabel={`${buddySetCopy.saveFailed} ${t('devices.resources.retry')}`}
        onPress={retrySaveBuddySets} hitSlop={spacing.xs} testID="home.buddySetsSaveRetry"
        style={({ pressed }) => [styles.moreRow, pressed && mobileInteractionStyles.pressed]}>
        <RefreshCw size={iconSize.sm} color={colors.textSecondary} strokeWidth={iconStroke.regular} />
        <Text style={styles.moreText} numberOfLines={1}>{buddySetCopy.saveFailed}</Text>
      </Pressable> : null}
      {!entries.length ? (<>
        {hasBuddySets && !collapsed ? <BuddySetGroups
          entries={[]}
          buddySets={buddySets}
          onChange={updateBuddySets}
          onEditSet={(buddySetId) => setBuddySetEdit({ visible: true, buddySetId })}
          renderRow={renderRow}
          query={search}
          runDisclosure={runDisclosure}
          prepareDisclosure={prepareDisclosure}
        /> : null}
        {canCreate ? <DisclosureItem exit>{create((press, label) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={press}
          style={({ pressed }) => [styles.addRow, pressed && mobileInteractionStyles.pressed]} testID="home.teammatesAdd">
          <View style={[styles.addCircle, styles.addCircleRow]}><Plus color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} /></View>
          <Text style={styles.addText} numberOfLines={1}>{t('devices.companions.createTeammate')}</Text>
        </Pressable>)}</DisclosureItem> : null}
      </>)
        : collapsed ? <DisclosureItem exit>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip} testID="home.teammatesStrip">
          {entries.map(entry => <StripCell key={`${entry.kind}:${entry.row.key}`} entry={entry}
            online={entry.kind === 'group' ? groups.isOnline(entry.row.host) : roster.isOnline(entry.row.host)}
            connected={entry.kind === 'bot' ? (roster.connectionState ? roster.connectionState(entry.row.host) : roster.isOnline(entry.row.host)) : null}
            quiet={entry.kind === 'bot' && quietPresence(entry.row)}
            onPress={() => entry.kind === 'group' ? openGroup(entry.row) : openTeammate(entry.row)} />)}
          {create((press, label) => <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={press}
            style={({ pressed }) => [styles.cell, pressed && mobileInteractionStyles.pressed]} testID="home.teammatesStripCreate">
            <View style={[styles.addCircle, styles.addCircleStrip]}><Plus color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} /></View>
            <View style={styles.cellNameSpace} />
          </Pressable>)}
        </ScrollView>
      </DisclosureItem>
      : <DisclosureItem exit>
        <BuddySetGroups
          entries={showAll ? entries : preview}
          buddySets={buddySets}
          onChange={updateBuddySets}
          onEditSet={(buddySetId) => setBuddySetEdit({ visible: true, buddySetId })}
          renderRow={(entry, last) => renderRow(entry, last && !hasMore)}
          query={search}
          runDisclosure={runDisclosure}
          prepareDisclosure={prepareDisclosure}
        />
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
    </>}
    {showFooter ? <View style={styles.footer} /> : null}
  </DisclosureItem> : null;
  return (
    <>
      {body}
      <MountOnFirstOpen open={optionsOpen}>
        {() => (
          <HomeSectionOptionsSheet
            visible={optionsOpen}
            title={title}
            sections={optionSections}
            testID="home.teammatesOptionsSheet"
            onClose={closeOptions}
            onClosed={handleOptionsClosed}
          />
        )}
      </MountOnFirstOpen>
      {creator.sheets}
      <BuddySetSheet visible={buddySetEdit.visible} buddySetId={buddySetEdit.buddySetId}
        buddySets={buddySets} candidates={buddySetCandidates} onChange={updateBuddySets}
        onClose={() => setBuddySetEdit({ visible: false, buddySetId: null })} />
    </>
  );
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
    <Text style={styles.cellName} numberOfLines={1}>{title}</Text>
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
  const group = entry.kind === 'group';
  const working = !group && online && !!display.generation;
  const activity = group && display.teammateActivity?.phase === 'running' ? undefined : display.teammateActivity;
  const status = resolveTeammateStatus({ online, unread, working, activities: [activity] });
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
    <Text style={styles.cellName} numberOfLines={1}>{title}</Text>
  </Pressable>;
}

function sameHosts(a: readonly RemoteResourceHostTarget[], b: readonly RemoteResourceHostTarget[]): boolean {
  return a.length === b.length && a.every((host, index) =>
    host.deviceId === b[index].deviceId && host.deviceName === b[index].deviceName);
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center' },
  headerToggle: { flex: 1, backgroundColor: 'transparent' },
  headerAdd: { width: 36, height: 36, marginRight: spacing.sm, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  strip: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  cell: { width: STRIP_CELL_WIDTH, minHeight: TEAMMATE_AVATAR.stripTarget, alignItems: 'center', gap: spacing.xs,
    paddingVertical: (TEAMMATE_AVATAR.stripTarget - STRIP_AVATAR_SIZE) / 2, borderRadius: radius.container },
  cellAvatar: { width: STRIP_AVATAR_SIZE, height: STRIP_AVATAR_SIZE },
  cellName: { width: STRIP_CELL_WIDTH, color: colors.textPrimary, fontSize: typeScale.caption, lineHeight: lineHeight.caption,
    fontWeight: fontWeight.medium, textAlign: 'center' },
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
