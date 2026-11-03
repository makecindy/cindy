/**
 * An independent task a teammate started from this group (bot-group-chat.md §10).
 *
 * My own teammate's task: the live task card read from the computer that runs it (same card
 * as a teammate chat); `deviceId` is that computer — the group's, or for a group opened straight
 * from the Chat Server the companion's home computer. Someone else's teammate, or a companion
 * whose computer is unknown: the card as it was posted — title and state.
 */
import { ListTodo } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupTaskCardView } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { CompanionTaskCard } from './CompanionMessageCard';

export function BotGroupTaskCard({ task, owned, deviceId }: { task: BotGroupTaskCardView; owned: boolean; deviceId: string }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  if (owned && deviceId && task.meta.parentSessionId) {
    return <View testID="botGroup.task.live">
      <CompanionTaskCard deviceId={deviceId} parentSessionId={task.meta.parentSessionId} meta={task.meta} />
    </View>;
  }
  const state = t(`groupChat.task.state.${task.state}`);
  return <View style={styles.card} testID="botGroup.task" accessibilityLabel={`${task.title} · ${state}`}>
    <ListTodo size={iconSize.sm} color={colors.textTertiary} style={styles.icon} />
    <View style={styles.body}>
      <Text numberOfLines={2} style={styles.title}>{task.title}</Text>
      <Text style={styles.state}>{state}</Text>
      {task.state === 'waiting' && task.summary ? <Text style={styles.summary}>{task.summary}</Text> : null}
    </View>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, alignSelf: 'stretch',
    backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  icon: { marginTop: 3 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  // 行标题 role (16 / 22, 500, textPrimary).
  title: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  // 状态词 role (12 / 18, 400, textTertiary).
  state: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  // 说明 role (13 / 18, 400, textSecondary): what the task is waiting on.
  summary: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
