import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatBotMessageGroupTime } from '@cindy/maker-shared/botTimeline';
import { Text } from '@/components/AppText';
import { fontWeight, lineHeight, radius, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';

/** Shared thread summary for group and companion conversations. */
export function ChatThreadSummary({ avatars, replyCount, lastReplyAt, unreadDot = false, leadingIcon, leadingLabel, leadingTestID, topicExcerpt, pill = false, trailing, onPress, onLongPress, testID, accessibilityHint, compact = false }: {
  avatars: ReactNode[];
  replyCount: number;
  lastReplyAt?: number | null;
  unreadDot?: boolean;
  leadingIcon?: ReactNode;
  leadingLabel?: string;
  leadingTestID?: string;
  topicExcerpt?: string;
  pill?: boolean;
  trailing?: ReactNode;
  onPress(): void;
  onLongPress?: () => void;
  testID: string;
  accessibilityHint?: string;
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  if (!replyCount) return null;
  let time: string | undefined;
  if (lastReplyAt) {
    if (compact) {
      time = formatBotMessageGroupTime(lastReplyAt, i18n.language);
    } else {
      const minutes = Math.max(0, Math.floor((Date.now() - lastReplyAt) / 60000));
      time = t(minutes < 60 ? 'groupChat.thread.lastMinutes' : 'groupChat.thread.lastHours', { count: minutes < 60 ? minutes : Math.floor(minutes / 60) });
    }
  }
  return <Pressable accessibilityRole="button" accessibilityHint={accessibilityHint} delayLongPress={260} hitSlop={compact ? spacing.xs : undefined} onPress={onPress} onLongPress={onLongPress}
    style={({ pressed }) => [styles.entry, compact && styles.compactEntry, pill && styles.pillEntry, pressed && styles.pressed]} testID={testID}>
    {leadingIcon}
    {leadingLabel ? <Text numberOfLines={1} style={styles.leadingLabel} testID={leadingTestID}>{leadingLabel}</Text> : null}
    {topicExcerpt ? (
      <Text numberOfLines={1} ellipsizeMode="tail" style={styles.topicExcerpt}>{topicExcerpt}</Text>
    ) : (
      <>
        {avatars.length ? <View style={styles.avatars}>{avatars.slice(0, 3).map((avatar, index) =>
          <View key={index} style={[styles.avatar, index ? styles.overlap : undefined, { zIndex: avatars.length - index }]}>{avatar}</View>)}</View> : null}
        <Text numberOfLines={1} style={[styles.count, compact && styles.compactCount]}>{t('groupChat.thread.replyCount', { count: replyCount })}</Text>
      </>
    )}
    {unreadDot ? <View style={styles.unreadDot} testID={`${testID}.unread`} /> : null}
    {time ? <Text numberOfLines={1} style={[styles.time, styles.detail]}>{time}</Text> : null}
    {trailing}
  </Pressable>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  // Compact visible row, retaining a 44pt touch target via hitSlop.
  entry: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, maxWidth: '100%', paddingTop: spacing.xs, paddingBottom: spacing.md },
  compactEntry: { minHeight: 32, paddingTop: spacing.xs, paddingBottom: 0, gap: spacing.xs + 2 },
  pillEntry: {
    minHeight: 28,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radius.control,
    backgroundColor: colors.chatCodeSurface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderTranslucent,
    gap: spacing.xs + 1,
  },
  leadingLabel: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary, flexShrink: 0 },
  topicExcerpt: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium, color: colors.groupMentionText, flexShrink: 1, minWidth: 0 },
  pressed: { opacity: 0.72 },
  avatars: { flexDirection: 'row', alignItems: 'center', paddingLeft: 1 },
  avatar: { borderRadius: radius.pill, borderWidth: 2, borderColor: colors.surface, overflow: 'hidden' },
  // 22% overlap on 16-18pt avatars keeps each initial legible.
  overlap: { marginLeft: -spacing.xs },
  count: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: colors.textPrimary, flexShrink: 0 },
  compactCount: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  unreadDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: colors.botUnread },
  time: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: colors.textTertiary },
  detail: { flexShrink: 1, minWidth: 0 },
});
