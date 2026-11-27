import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatBotMessageGroupTime } from '@cindy/maker-shared/botTimeline';
import { Text } from '@/components/AppText';
import { fontWeight, lineHeight, radius, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';

/** Shared thread summary for group and companion conversations. */
export function ChatThreadSummary({ avatars, replyCount, lastReplyAt, onPress, testID, accessibilityHint, compact = false }: {
  avatars: ReactNode[];
  replyCount: number;
  lastReplyAt?: number | null;
  onPress(): void;
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
  return <Pressable accessibilityRole="button" accessibilityHint={accessibilityHint} onPress={onPress} style={[styles.entry, compact && styles.compactEntry]} testID={testID}>
    {avatars.length ? <View style={styles.avatars}>{avatars.slice(0, 3).map((avatar, index) =>
      <View key={index} style={[styles.avatar, index ? styles.overlap : undefined, { zIndex: avatars.length - index }]}>{avatar}</View>)}</View> : null}
    <Text numberOfLines={1} style={styles.count}>{t('groupChat.thread.replyCount', { count: replyCount })}</Text>
    {time ? <Text numberOfLines={1} style={[styles.time, styles.detail]}>{time}</Text> : null}
  </Pressable>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  // Compact visible row, retaining a 44pt touch target below it.
  entry: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, maxWidth: '100%', paddingTop: spacing.xs, paddingBottom: spacing.md },
  compactEntry: { paddingTop: 0, paddingBottom: 0 },
  avatars: { flexDirection: 'row', alignItems: 'center', paddingLeft: 1 },
  avatar: { borderRadius: radius.pill, borderWidth: 2, borderColor: colors.surface, overflow: 'hidden' },
  overlap: { marginLeft: -spacing.md },
  count: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: colors.textPrimary, flexShrink: 0 },
  time: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: colors.textTertiary },
  detail: { flexShrink: 1, minWidth: 0 },
});
