import { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import { BellRing, CircleDot, GitPullRequest, MessagesSquare, Search, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupThreadSummary } from '@cindy/maker-shared/botGroupChat';
import {
  botGroupCodeRefLabel,
  botGroupThreadActivityAt,
  filterBotGroupThreads,
  formatBotGroupThreadRootTitle,
  isBotGroupThreadActionable,
  pickBotGroupThreadDisplayRefs,
  type BotGroupThreadFilter,
} from '@cindy/maker-shared/botGroupPresentation';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { BotGroupAvatar } from './BotGroupAvatars';
import type { BotGroupIdentityLookup } from './BotGroupPlan';
import { CompanionSheet } from './CompanionSheet';
import { FileBrowserSegmentedControl, type FileBrowserSegmentOption } from './FileBrowserSegmentedControl';

const key = (name: string) => `groupChat.thread.${name}`;

function formatCompactTime(at: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (!at) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 60) return t(key('lastMinutes'), { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(key('lastHours'), { count: hours });
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ThreadRow({
  thread,
  identityFor,
  onPress,
}: {
  thread: BotGroupThreadSummary;
  identityFor: BotGroupIdentityLookup;
  onPress(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const actionable = isBotGroupThreadActionable(thread);
  const activityAt = botGroupThreadActivityAt(thread);
  const timeText = formatCompactTime(activityAt, t);
  const { issue, pr } = pickBotGroupThreadDisplayRefs(thread.refs);
  const rootTitle = formatBotGroupThreadRootTitle(thread, {
    kinds: {
      task: t(key('rootKind.task')),
      image: t(key('rootKind.image')),
      video: t(key('rootKind.video')),
      audio: t(key('rootKind.audio')),
      file: t(key('rootKind.file')),
      share: t(key('rootKind.share')),
      card: t(key('rootKind.card')),
    },
    empty: t(key('emptyReply')),
  });

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        testID={`botGroup.threadIndex.row.${thread.rootId}`}
        onPress={onPress}
        style={({ pressed }) => [styles.rowBody, pressed && styles.rowPressed]}
      >
        <View style={styles.rowHeader}>
          <BotGroupAvatar
            deviceId=""
            online
            identity={identityFor(thread.rootAuthorBotId ?? '', thread.rootAuthorName || '?')}
            size={iconSize.lg}
          />
          <Text numberOfLines={1} style={[styles.rootText, actionable && styles.rootTextUnread]}>
            {rootTitle}
          </Text>
          {timeText ? <Text style={styles.timeText}>{timeText}</Text> : null}
        </View>
      </Pressable>

      <View style={styles.metaRow}>
        <Pressable accessibilityRole="button" onPress={onPress} style={styles.metaMain}>
          <Text style={styles.metaText}>{t(key('replyCount'), { count: thread.replyCount })}</Text>
          {thread.unread.mentioned && actionable ? (
            <View style={styles.tagPill}>
              <Text style={[styles.tagText, styles.tagTextStrong]}>{t(key('mentioned'))}</Text>
            </View>
          ) : thread.mentionedMe ? (
            <View style={styles.tagPill}>
              <Text style={styles.tagText}>{t(key('indexMentionedTag'))}</Text>
            </View>
          ) : thread.participated ? (
            <Text style={styles.metaText}>· {t(key('indexParticipatedTag'))}</Text>
          ) : null}
          {thread.following ? (
            <BellRing size={iconSize.xs} color={colors.textTertiary} />
          ) : null}
        </Pressable>
        {(issue || pr || actionable) ? (
          <View style={styles.trailingMeta}>
            {issue ? (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`${issue.owner}/${issue.repo}${botGroupCodeRefLabel(issue)}`}
                testID={`botGroup.threadIndex.ref.issue.${thread.rootId}`}
                onPress={() => { void Linking.openURL(issue.url); }}
                hitSlop={6}
                style={({ pressed }) => [styles.codeRef, pressed && styles.codeRefPressed]}
              >
                <CircleDot size={iconSize.xs} color={colors.textTertiary} />
                <Text style={styles.codeRefText}>{botGroupCodeRefLabel(issue)}</Text>
              </Pressable>
            ) : null}
            {pr ? (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`${pr.owner}/${pr.repo}${botGroupCodeRefLabel(pr)}`}
                testID={`botGroup.threadIndex.ref.pr.${thread.rootId}`}
                onPress={() => { void Linking.openURL(pr.url); }}
                hitSlop={6}
                style={({ pressed }) => [styles.codeRef, pressed && styles.codeRefPressed]}
              >
                <GitPullRequest size={iconSize.xs} color={colors.textTertiary} />
                <Text style={styles.codeRefText}>{botGroupCodeRefLabel(pr)}</Text>
              </Pressable>
            ) : null}
            {actionable ? (
              <View style={styles.unreadWrap}>
                <View style={styles.unreadDot} />
                <Text style={styles.unreadText}>{t(key('newReplies'), { count: thread.unread.count })}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Quiet in-group 话题 index sheet on mobile (mirrors Desktop's ChatThreadListPanel). */
export function BotGroupThreadListSheet({
  visible,
  threads,
  filter,
  onFilterChange,
  syncing = false,
  identityFor,
  onSelect,
  onClose,
  onClosed,
}: {
  visible: boolean;
  threads: readonly BotGroupThreadSummary[];
  filter: BotGroupThreadFilter;
  onFilterChange(next: BotGroupThreadFilter): void;
  syncing?: boolean;
  identityFor: BotGroupIdentityLookup;
  onSelect(rootId: string, focusMessageId?: string): void;
  onClose(): void;
  onClosed?(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [query, setQuery] = useState('');

  const options = useMemo<readonly FileBrowserSegmentOption<BotGroupThreadFilter>[]>(() => [
    { value: 'mine', label: t(key('filterMine')), testID: 'botGroup.threadIndex.filter.mine' },
    { value: 'all', label: t(key('filterAll')), testID: 'botGroup.threadIndex.filter.all' },
  ], [t]);

  const { unread, recent } = useMemo(
    () => filterBotGroupThreads(threads, filter, query),
    [threads, filter, query],
  );
  const totalShown = unread.length + recent.length;
  const emptyKey = query.trim()
    ? 'indexEmptySearch'
    : filter === 'mine'
      ? 'indexEmptyMine'
      : 'indexEmptyAll';

  const openThread = (thread: BotGroupThreadSummary) => {
    const focusId = filter === 'mine' && (thread.unread.mentioned || thread.mentionedMe)
      ? thread.lastMention?.messageId
      : undefined;
    onSelect(thread.rootId, focusId);
  };

  return (
    <CompanionSheet
      visible={visible}
      title={t(key('indexTitle'))}
      initialSnap="full"
      onClose={onClose}
      onClosed={onClosed}
      testID="botGroup.threadIndex.sheet"
    >
      <View style={styles.content}>
        <FileBrowserSegmentedControl
          accessibilityLabel={t(key('filterAria'))}
          options={options}
          value={filter}
          onChange={onFilterChange}
          testID="botGroup.threadIndex.filter"
        />

        <View style={styles.searchBox}>
          <Search size={iconSize.sm} color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t(key('searchPlaceholder'))}
            placeholderTextColor={colors.textPlaceholder}
            accessibilityLabel={t(key('searchPlaceholder'))}
            returnKeyType="search"
            testID="botGroup.threadIndex.search"
            style={styles.searchInput}
          />
          {query.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(key('clearSearch'))}
              onPress={() => setQuery('')}
              hitSlop={8}
              style={styles.clearButton}
            >
              <X size={iconSize.xs} color={colors.textTertiary} />
            </Pressable>
          ) : null}
        </View>

        {totalShown === 0 && syncing ? (
          <View style={styles.empty} testID="botGroup.threadIndex.syncing">
            <ActivityIndicator size="small" color={colors.textTertiary} />
            <Text style={styles.emptyText}>{t(key('syncingHistory'))}</Text>
          </View>
        ) : totalShown === 0 ? (
          <View style={styles.empty}>
            <MessagesSquare size={iconSize.xl} color={colors.textTertiary} />
            <Text style={styles.emptyText}>{t(key(emptyKey))}</Text>
            {!query.trim() && filter !== 'all' && threads.length > 0 ? (
              <MainWindowActionButton
                density="compact"
                action={{
                  label: t(key('viewAllThreads')),
                  onPress: () => onFilterChange('all'),
                  testID: 'botGroup.threadIndex.viewAll',
                }}
              />
            ) : null}
          </View>
        ) : (
          <View style={styles.list}>
            {unread.length > 0 ? (
              <>
                <Text style={styles.sectionTitle}>{t(key('listNews'))}</Text>
                {unread.map(thread => (
                  <ThreadRow
                    key={thread.rootId}
                    thread={thread}
                    identityFor={identityFor}
                    onPress={() => openThread(thread)}
                  />
                ))}
              </>
            ) : null}
            {recent.length > 0 ? (
              <>
                {unread.length > 0 ? <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>{t(key('listRecent'))}</Text> : null}
                {recent.map(thread => (
                  <ThreadRow
                    key={thread.rootId}
                    thread={thread}
                    identityFor={identityFor}
                    onPress={() => openThread(thread)}
                  />
                ))}
              </>
            ) : null}
            {syncing ? (
              <View style={styles.syncingFooter} testID="botGroup.threadIndex.syncing">
                <ActivityIndicator size="small" color={colors.textTertiary} />
                <Text style={styles.metaText}>{t(key('syncingHistory'))}</Text>
              </View>
            ) : null}
          </View>
        )}
      </View>
    </CompanionSheet>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: spacing.md },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    fontSize: typeScale.bodySmall,
    lineHeight: lineHeight.bodySmall,
    color: colors.textPrimary,
    paddingVertical: spacing.xs,
  },
  clearButton: { padding: spacing.xs },
  list: { gap: spacing.xs },
  sectionTitle: {
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    fontWeight: fontWeight.medium,
    color: colors.textSecondary,
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.xs,
  },
  sectionTitleSpaced: { paddingTop: spacing.md },
  row: {
    borderRadius: radius.control,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  rowBody: {
    borderRadius: radius.control,
    gap: spacing.xs,
  },
  rowPressed: { backgroundColor: colors.surfaceChip },
  metaMain: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
    flexShrink: 1,
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rootText: {
    flex: 1,
    minWidth: 0,
    fontSize: typeScale.bodySmall,
    lineHeight: lineHeight.bodySmall,
    fontWeight: fontWeight.regular,
    color: colors.textPrimary,
  },
  rootTextUnread: { fontWeight: fontWeight.medium },
  timeText: {
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    color: colors.textTertiary,
    flexShrink: 0,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
    paddingLeft: 26,
  },
  metaText: {
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    color: colors.textTertiary,
  },
  tagPill: {
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceChip,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 1,
  },
  tagText: {
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    color: colors.textSecondary,
  },
  tagTextStrong: {
    fontWeight: fontWeight.medium,
    color: colors.textPrimary,
  },
  trailingMeta: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  codeRef: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: radius.micro,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
  },
  codeRefPressed: {
    backgroundColor: colors.surfaceChip,
  },
  codeRefText: {
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    fontVariant: ['tabular-nums'],
    color: colors.textTertiary,
  },
  unreadWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.botUnread,
  },
  unreadText: {
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    fontWeight: fontWeight.medium,
    color: colors.textPrimary,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl * 2,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  emptyText: {
    fontSize: typeScale.bodySmall,
    lineHeight: lineHeight.bodySmall,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  syncingFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
  },
});
