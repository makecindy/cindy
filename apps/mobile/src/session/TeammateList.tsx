import { readWorkingPhase } from '@cindy/maker-shared';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { ActivityIndicator, Animated, Easing, FlatList, Image, Pressable, RefreshControl, StyleSheet, View, type ScrollViewProps } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Search, X } from 'lucide-react-native';
import { resolveRemoteText } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowEmptyState, RemoteListSyncingPlaceholder } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { useAuth } from '@/auth/AuthContext';
import { isRemoteResourceUnread } from '@/device-link/remoteResourceCache';
import type { HostedRemoteCollectionItem, RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { useMinuteNow } from '@/utils/useMinuteNow';
import { useThemedStyles, useTheme, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { BotGroupListRow, OFFLINE_AVATAR_OPACITY } from './BotGroupList';
import { orderedBotGroups } from './botGroupRemote';
import { CompanionListRow, CompanionPresenceDot, COMPANION_ROW_AVATAR_SIZE, COMPANION_ROW_HEIGHT } from './CompanionListRow';
import { CompanionPresenceRing } from './CompanionPresenceRing';
import { remoteSessionStore } from './remoteSessionStore';
import { formatRemoteSessionSidebarTime } from './sessionList';
import { orderedTeammates } from './teammateNavigation';
import { parseMobileMarkdownInlines } from './messageMarkdown';
import { TeammateGenerationLabel } from './TeammateGenerationLabel';

/** Loading placeholders appear only when the first read takes longer than this (no flash on fast loads). */
const SKELETON_DELAY_MS = 300;
/** Half-period of the placeholder breath: the running breath's 1.5s cycle. */
const SKELETON_HALF_MS = 750;
const SKELETON_WIDTHS = [[96, 210], [72, 180], [120, 232], [84, 160], [104, 200], [64, 190]] as const;
const EMPTY_PRESETS = [
  require('../../assets/bot-presets/cindy.png'),
  require('../../assets/bot-presets/dash.png'),
  require('../../assets/bot-presets/lizi.png'),
];
const EMPTY_PRESET_SIZE = 56;

export interface TeammateListGroups {
  items: readonly HostedRemoteCollectionItem[];
  isOnline(host: RemoteResourceHostTarget): boolean;
  onSelect(item: HostedRemoteCollectionItem): void;
}

export interface TeammateListProps {
  items: readonly HostedRemoteCollectionItem[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  isOnline(host: RemoteResourceHostTarget): boolean;
  connectionState?(host: RemoteResourceHostTarget): boolean | null;
  onRefresh(): void;
  onSelect(item: HostedRemoteCollectionItem): void;
  /** SheetSurface already owns the scroll view. */
  embedded?: boolean;
  autoFocusSearch?: boolean;
  onInteract?(): void;
  /** Home only: group chats, mixed with the teammates by latest activity and filtered by the same search. */
  groups?: TeammateListGroups;
  /** Home only: the create entry shown under an empty list. */
  emptyAction?: ReactElement | null;
  /** 独立整页、铺到透明系统顶栏下时,由列表自己让出上下安全区。 */
  scrollInsetProps?: Pick<ScrollViewProps, 'automaticallyAdjustsScrollIndicatorInsets' | 'contentInsetAdjustmentBehavior'>;
}

type ListEntry = { kind: 'bot' | 'group'; row: HostedRemoteCollectionItem };

function conversationSessionId(row: HostedRemoteCollectionItem): string | null {
  const target = row.item.links.find(({ rel, target: link }) => rel === 'conversation' && link.kind === 'session')?.target;
  return target?.kind === 'session' ? target.sessionId : null;
}

/** Bot conversations stopped on a question or a permission prompt (「等你确认」). */
function useAwaitingSessions(items: readonly HostedRemoteCollectionItem[]): ReadonlySet<string> {
  const sessions = useMemo(() => items.map(conversationSessionId).filter((id): id is string => !!id), [items]);
  const snapshot = useCallback(() => sessions.filter((id) => remoteSessionStore.getSessionLiveActivity(id)?.phase === 'needs-interaction'
    || remoteSessionStore.getPendingInteractions(id).length > 0).join('\u0000'), [sessions]);
  // A joined id string keeps unrelated store churn (streaming, other sessions) from re-rendering the list.
  const key = useSyncExternalStore(remoteSessionStore.subscribe, snapshot);
  return useMemo(() => new Set(key ? key.split('\u0000') : []), [key]);
}

/** Identity list shared by home (with group chats) and the collection route. No host headings. */
export function TeammateList({ items, loading, refreshing, error, isOnline, connectionState, onRefresh, onSelect,
  embedded = false, autoFocusSearch = false, onInteract, groups, emptyAction, scrollInsetProps }: TeammateListProps) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const now = useMinuteNow();
  const [query, setQuery] = useState('');
  const awaiting = useAwaitingSessions(items);
  const entries = useMemo<ListEntry[]>(() => {
    const bots = orderedTeammates(items, query, i18n.language).map((row) => ({ kind: 'bot' as const, row }));
    if (!groups) return bots;
    const chats = orderedBotGroups(groups.items, query, i18n.language).map((row) => ({ kind: 'group' as const, row }));
    return [...bots, ...chats].sort((a, b) => (b.row.item.display.timestamp ?? 0) - (a.row.item.display.timestamp ?? 0));
  }, [groups, items, query, i18n.language]);
  const duplicateNames = useMemo(() => {
    const names = new Map<string, number>();
    for (const row of items) {
      const name = resolveRemoteText(row.item.display.title, i18n.language).normalize('NFKC').toLocaleLowerCase(i18n.language);
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    return names;
  }, [items, i18n.language]);
  const searchLabel = t(groups ? 'devices.companions.searchWithGroups' : 'devices.companions.search');
  const header = <View style={styles.controls}>
    <View style={styles.search}>
      <Search size={iconSize.md} color={colors.textPlaceholder} strokeWidth={iconStroke.regular} />
      <TextInput accessibilityLabel={searchLabel} autoFocus={autoFocusSearch}
        autoCorrect={false} onChangeText={(value) => { onInteract?.(); setQuery(value); }} onFocus={onInteract} placeholder={searchLabel}
        placeholderTextColor={colors.textPlaceholder} selectionColor={colors.inputCaret}
        style={styles.searchInput} value={query} testID="teammates.search" />
      {/* Mirrors HomeSearchBar: the trailing X clears typed text. */}
      {query.trim() ? <Pressable accessibilityRole="button" hitSlop={spacing.xs}
        accessibilityLabel={t('devices.detail.search.clearA11y')}
        onPress={() => setQuery('')}
        style={({ pressed }) => [styles.searchButton, pressed && mobileInteractionStyles.pressed]} testID="teammates.searchClose">
        <X color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
      </Pressable> : null}
    </View>
    {error ? <View style={styles.noticeRow}>
      <Text accessibilityRole="alert" style={[styles.notice, styles.noticeText]} testID="teammates.error">{t(items.length ? 'devices.companions.stale' : 'devices.resources.loadFailed')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('devices.resources.retry')} disabled={refreshing}
        onPress={onRefresh} style={styles.retry} testID="teammates.refresh">
        {refreshing ? <ActivityIndicator color={colors.textSecondary} /> : <RefreshCw size={iconSize.sm} color={colors.textSecondary} />}
      </Pressable>
    </View> : null}
  </View>;
  const searching = !!query.trim();
  const empty = loading
    ? (embedded
      ? <RemoteListSyncingPlaceholder testID="teammates.loading" />
      : <TeammateListSkeleton />)
    : searching || error || !emptyAction
      ? <MainWindowEmptyState centered style={styles.empty} testID="teammates.empty"
        title={searching ? t('devices.companions.noResults') : t('devices.companions.emptyTitle')}
        copy={searching || error ? '' : t('devices.companions.emptyCopy')} />
      : <View style={styles.emptyHome} testID="teammates.empty">
        <View style={styles.presetStack} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {EMPTY_PRESETS.map((source, index) => <Image key={index} source={source} style={[styles.preset, index > 0 && styles.presetOverlap]} />)}
        </View>
        <Text accessibilityRole="header" style={styles.emptyTitle}>{t('devices.companions.emptyTitle')}</Text>
        <Text style={styles.emptyCopy}>{t('devices.companions.emptyCopyCreate')}</Text>
        <View style={styles.emptyAction}>{emptyAction}</View>
      </View>;
  const renderBot = (row: HostedRemoteCollectionItem, last: boolean) => {
    const display = row.item.display;
    const title = resolveRemoteText(display.title, i18n.language);
    const preview = display.preview ? parseMobileMarkdownInlines(resolveRemoteText(display.preview, i18n.language))
      .map(inline => inline.type === 'image' ? inline.alt : inline.text).join('').replace(/\s+/g, ' ').trim() : '';
    const online = isOnline(row.host);
    const connected = connectionState ? connectionState(row.host) : online;
    // Desktop BotsSidebar: the cached reply stays readable offline; then the description, then an invitation.
    const subtitle = display.subtitle ? resolveRemoteText(display.subtitle, i18n.language).replace(/\s+/g, ' ').trim() : '';
    const summary = preview || subtitle || t('devices.companions.startChat');
    const generating = online && !!display.generation;
    const workingCopy = generating ? t(`devices.companions.working.${readWorkingPhase(display.generation!.phase) ?? 'processing'}`) : '';
    const attention = display.status?.tone === 'warning' || display.status?.tone === 'critical'
      ? resolveRemoteText(display.status.label, i18n.language) : '';
    const sessionId = conversationSessionId(row);
    const waiting = online && !generating && !!sessionId && awaiting.has(sessionId);
    const ambiguous = (duplicateNames.get(title.normalize('NFKC').toLocaleLowerCase(i18n.language)) ?? 0) > 1;
    const unread = isRemoteResourceUnread(user?.id ?? '', row.host.deviceId, row.item.ref.id, display.lastReplyAt);
    const timestamp = display.timestamp;
    const time = timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime())
      ? formatRemoteSessionSidebarTime(new Date(timestamp).toISOString(), now) : '';
    const connection = connected === false ? t('devices.resources.hostOffline') : connected === null ? t('devices.resources.connectionUnknown') : '';
    const prefix = attention || (waiting ? t('devices.companions.awaiting') : '');
    return <CompanionListRow key={`bot:${row.key}`} testID={`teammates.item.${row.host.deviceId}.${row.item.ref.id}`}
      accessibilityLabel={[title, ambiguous ? row.host.deviceName : '', connection, prefix, generating ? workingCopy : summary, time,
        unread ? t('devices.companions.unread') : ''].filter(Boolean).join(', ')}
      avatar={<>
        <View style={!online ? { opacity: OFFLINE_AVATAR_OPACITY } : undefined}>
          <RemoteCompanionAvatar avatar={display.avatar} deviceId={row.host.deviceId} name={title} online={online} size={COMPANION_ROW_AVATAR_SIZE} framed />
        </View>
        <CompanionPresenceRing active={generating} />
        <CompanionPresenceDot connected={connected} />
      </>}
      title={title}
      device={ambiguous ? row.host.deviceName : undefined}
      trailing={generating ? { kind: 'working' } : { kind: 'time', text: time }}
      preview={generating
        ? <TeammateGenerationLabel deviceId={row.host.deviceId} botId={row.item.ref.id} generation={display.generation!} />
        : connection ? `${connection} · ${summary}` : summary}
      previewTone={connection ? 'tertiary' : 'secondary'}
      previewPrefix={connection ? undefined : prefix || undefined}
      previewPrefixTestID={attention ? 'teammate.attention' : undefined}
      unread={unread}
      unreadLabel={t('devices.companions.unread')}
      disabled={!online}
      last={last}
      onPress={() => onSelect(row)} />;
  };
  const renderEntry = (entry: ListEntry, index: number) => {
    const last = index === entries.length - 1;
    if (entry.kind === 'bot' || !groups) return renderBot(entry.row, last);
    return <BotGroupListRow key={`group:${entry.row.key}`} row={entry.row} online={groups.isOnline(entry.row.host)} last={last}
      onPress={() => groups.onSelect(entry.row)} />;
  };
  if (embedded) return <View testID="teammates.list">{header}{entries.length ? entries.map(renderEntry) : empty}</View>;
  return <FlatList {...scrollInsetProps} style={styles.list} contentContainerStyle={styles.content} data={entries} keyExtractor={(entry) => `${entry.kind}:${entry.row.key}`}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" onScrollBeginDrag={onInteract} testID="teammates.list"
    ListHeaderComponent={header} ListEmptyComponent={empty} renderItem={({ item, index }) => renderEntry(item, index)}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />} />;
}

/**
 * First-load placeholders with the real row geometry. They appear only after SKELETON_DELAY_MS and
 * breathe in opacity only (no shimmer gradient); reduced motion keeps them still.
 */
function TeammateListSkeleton() {
  const styles = useThemedStyles(makeStyles);
  const animate = useReduceMotionEnabled() === false;
  const [shown, setShown] = useState(false);
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!shown || !animate) { opacity.setValue(1); return; }
    const step = (toValue: number) => Animated.timing(opacity, { toValue, duration: SKELETON_HALF_MS, easing: Easing.inOut(Easing.ease), useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([step(0.55), step(1)]));
    loop.start();
    return () => loop.stop();
  }, [animate, opacity, shown]);
  if (!shown) return null;
  return <Animated.View style={{ opacity }} testID="teammates.loading" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {SKELETON_WIDTHS.map(([title, preview], index) => <View key={index} style={styles.skeletonRow}>
      <View style={styles.skeletonAvatar} />
      <View style={[styles.skeletonBody, index < SKELETON_WIDTHS.length - 1 && styles.skeletonDivider]}>
        <View style={[styles.skeletonBar, styles.skeletonTitle, { width: title }]} />
        <View style={[styles.skeletonBar, { width: preview }]} />
      </View>
    </View>)}
  </Animated.View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  list: { flex: 1 },
  content: { flexGrow: 1, paddingBottom: spacing.xl },
  controls: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.sm, gap: spacing.sm },
  // Same pill as HomeSearchBar; the field text follows the 15pt search-box role.
  search: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingLeft: spacing.lg, paddingRight: spacing.xs,
    borderRadius: radius.pill, backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
  searchInput: { flex: 1, minWidth: 0, minHeight: 44, paddingVertical: spacing.sm, color: colors.textPrimary, fontSize: typeScale.bodySmall },
  // 36 visible + hitSlop 4 on each side = 44pt target.
  searchButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  notice: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  empty: { padding: spacing.xl, gap: spacing.md },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  noticeText: { flex: 1 },
  retry: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  emptyHome: { alignItems: 'center', paddingHorizontal: spacing.xxl, paddingTop: spacing.xxl * 2, gap: spacing.sm },
  presetStack: { flexDirection: 'row', marginBottom: spacing.md },
  preset: { width: EMPTY_PRESET_SIZE, height: EMPTY_PRESET_SIZE, borderRadius: radius.pill, borderWidth: 3, borderColor: colors.surface },
  presetOverlap: { marginLeft: -(spacing.md + 2) },
  emptyTitle: { color: colors.textPrimary, fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold, textAlign: 'center' },
  emptyCopy: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, textAlign: 'center', maxWidth: 260 },
  emptyAction: { marginTop: spacing.md },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, height: COMPANION_ROW_HEIGHT, paddingLeft: spacing.lg },
  skeletonAvatar: { width: COMPANION_ROW_AVATAR_SIZE, height: COMPANION_ROW_AVATAR_SIZE, borderRadius: radius.pill, backgroundColor: colors.surfaceChip },
  skeletonBody: { flex: 1, alignSelf: 'stretch', justifyContent: 'center', gap: spacing.md, paddingRight: spacing.lg },
  skeletonDivider: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  skeletonBar: { height: spacing.md, borderRadius: radius.micro, backgroundColor: colors.surfaceChip },
  skeletonTitle: { height: spacing.lg - 2 },
});
