import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { BellRing, MessagesSquare, Search, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupThreadSummary } from '@cindy/maker-shared/botGroupChat';
import {
  botGroupThreadActivityAt,
  filterBotGroupThreads,
  isBotGroupThreadActionable,
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
  filter,
  identityFor,
  onPress,
}: {
  thread: BotGroupThreadSummary;
  filter: BotGroupThreadFilter;
  identityFor: BotGroupIdentityLookup;
  onPress(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const actionable = isBotGroupThreadActionable(thread);
  const preview = (filter === 'mentions' && thread.lastMention ? thread.lastMention : null) ?? thread.lastReply;
  const activityAt = botGroupThreadActivityAt(thread);
  const timeText = formatCompactTime(activityAt, t);
  const responders = thread.responders ?? [];

  return (
    <Pressable
      accessibilityRole="button"
      testID={`botGroup.threadIndex.row.${thread.rootId}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowHeader}>
        <BotGroupAvatar
          deviceId=""
          online
          identity={identityFor(thread.rootAuthorBotId ?? '', thread.rootAuthorName || '?')}
          size={iconSize.lg}
        />
        <Text numberOfLines={1} style={[styles.rootText, actionable && styles.rootTextUnread]}>
          {thread.rootText || t(key('emptyReply'))}
        </Text>
        {timeText ? <Text style={styles.timeText}>{timeText}</Text> : null}
      </View>

      {preview ? (
        <Text numberOfLines={1} style={styles.previewText}>
          <Text style={styles.previewAuthor}>{preview.authorName}</Text>
          {': '}
          {preview.text || t(key('emptyReply'))}
        </Text>
      ) : null}

      <View style={styles.metaRow}>
        {responders.length > 0 ? (
          <View style={styles.responders}>
            {responders.slice(0, 3).map((responder, index) => (
              <View
                key={responder.id}
                style={[styles.responderAvatar, index > 0 && styles.responderOverlap, { zIndex: responders.length - index }]}
              >
                <BotGroupAvatar
                  deviceId=""
                  online
                  identity={identityFor(responder.authorBotId ?? '', responder.authorName)}
                  size={iconSize.md}
                />
              </View>
            ))}
          </View>
        ) : null}
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
        {actionable ? (
          <View style={styles.unreadWrap}>
            <View style={styles.unreadDot} />
            <Text style={styles.unreadText}>{t(key('newReplies'), { count: thread.unread.count })}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Quiet in-group 话题 index sheet on mobile (mirrors Desktop's ChatThreadListPanel). */
export function BotGroupThreadListSheet({
  visible,
  threads,
  filter,
  onFilterChange,
  identityFor,
  onSelect,
  onClose,
  onClosed,
}: {
  visible: boolean;
  threads: readonly BotGroupThreadSummary[];
  filter: BotGroupThreadFilter;
  onFilterChange(next: BotGroupThreadFilter): void;
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
    { value: 'mentions', label: t(key('filterMentions')), testID: 'botGroup.threadIndex.filter.mentions' },
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
      : filter === 'mentions'
        ? 'indexEmptyMentions'
        : 'indexEmptyAll';

  const openThread = (thread: BotGroupThreadSummary) => {
    const focusId = filter === 'mentions' ? thread.lastMention?.messageId : undefined;
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

        {totalShown === 0 ? (
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
                    filter={filter}
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
                    filter={filter}
                    identityFor={identityFor}
                    onPress={() => openThread(thread)}
                  />
                ))}
              </>
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
  rowPressed: { backgroundColor: colors.surfaceChip },
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
  previewText: {
    paddingLeft: 26,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    color: colors.textSecondary,
  },
  previewAuthor: { fontWeight: fontWeight.medium, color: colors.textPrimary },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
    paddingLeft: 26,
  },
  responders: { flexDirection: 'row', alignItems: 'center' },
  responderAvatar: {
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.surface,
    overflow: 'hidden',
  },
  responderOverlap: { marginLeft: -spacing.xs },
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
  unreadWrap: {
    marginLeft: 'auto',
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
});
