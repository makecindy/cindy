/** 群聊与伙伴私聊共用的引用摘要（Telegram 轻量风格）：圆角淡蓝底 + 随圆角贴合的左侧强调竖条 + 作者 + 单行预览。 */
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupQuoteDisplay } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { playHaptic } from '@/platform/haptics';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { useTriggerMessageLongPress } from './botGroupMessageGestureContext';

export function BotGroupQuote({ display, align = 'left', surface = 'card', onPress }: {
  display: BotGroupQuoteDisplay;
  align?: 'left' | 'right';
  surface?: 'card' | 'inline';
  onPress?: () => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const triggerMessageLongPress = useTriggerMessageLongPress();
  const deleted = display.state === 'deleted';
  const rawSummary = deleted
    ? t('groupChat.quote.deleted')
    : display.excerpt || (display.attachmentName && display.attachmentCount > 1
      ? t('groupChat.quote.attachments', { name: display.attachmentName, total: display.attachmentCount })
      : display.attachmentName ?? '');
  const summary = rawSummary.replace(/\s+/g, ' ').trim();
  const content = (
    <>
      <View
        pointerEvents="none"
        style={surface === 'inline' ? styles.accentBarInline : styles.accentBarCard}
      />
      <View style={styles.textColumn}>
        <Text numberOfLines={1} style={styles.author}>{display.authorName}</Text>
        <Text numberOfLines={1} style={deleted ? styles.deleted : styles.excerpt}>{summary}</Text>
      </View>
    </>
  );
  const label = t('groupChat.quote.label', { name: display.authorName, summary });
  const containerStyle = surface === 'inline' ? styles.inline : styles.card;
  return onPress ? (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      delayLongPress={260}
      onPress={() => {
        playHaptic('selection');
        onPress();
      }}
      onLongPress={triggerMessageLongPress ?? undefined}
      style={({ pressed }) => [containerStyle, styles.fill, pressed && styles.pressed]}
      testID="botGroup.quote"
    >
      {content}
    </Pressable>
  ) : (
    <View
      accessible
      accessibilityLabel={label}
      style={[containerStyle, align === 'right' && styles.right]}
      testID="botGroup.quote"
    >
      {content}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { position: 'relative', overflow: 'hidden', maxWidth: '92%', borderRadius: radius.control, backgroundColor: `${colors.botUnread}14`, paddingHorizontal: spacing.sm + 2, paddingVertical: 5 },
  inline: { flexDirection: 'row', alignItems: 'stretch', gap: spacing.sm },
  accentBarCard: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colors.botUnread },
  accentBarInline: { width: 3, borderRadius: radius.pill, backgroundColor: colors.botUnread, marginVertical: 2 },
  textColumn: { flexShrink: 1, minWidth: 0, gap: 1 },
  right: { alignSelf: 'flex-end' },
  fill: { maxWidth: '100%' },
  pressed: { opacity: 0.72 },
  author: { color: colors.groupMentionText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold },
  excerpt: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  deleted: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
});
