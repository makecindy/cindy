/**
 * 群聊「引用回复」的引用块（docs/product-rules/bot-group-chat.md §10「引用回复」）。
 * 手机只显示：作者与最多一行摘要，竖线与 Markdown 引用同一样式；原消息已删除时只显示
 * 作者与「原消息已删除」。群聊的发起引用与跳转原消息目前只在电脑上；伙伴私聊在手机上也能发起和跳转。
 */
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupQuoteDisplay } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';

export function BotGroupQuote({ display, align = 'left', onPress }: {
  display: BotGroupQuoteDisplay;
  align?: 'left' | 'right';
  /** 伙伴私聊：点引用块跳到原消息。群聊暂不跳转。 */
  onPress?: () => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const deleted = display.state === 'deleted';
  const summary = deleted
    ? t('groupChat.quote.deleted')
    : display.excerpt || (display.attachmentName && display.attachmentCount > 1
      ? t('groupChat.quote.attachments', { name: display.attachmentName, total: display.attachmentCount })
      : display.attachmentName ?? '');
  const content = <>
    <Text numberOfLines={1} style={styles.author}>{display.authorName}</Text>
    <Text numberOfLines={1} style={deleted ? styles.deleted : styles.excerpt}>{summary}</Text>
  </>;
  const label = t('groupChat.quote.label', { name: display.authorName, summary });
  return onPress ? (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.quote, styles.fill, pressed && styles.pressed]}
      testID="botGroup.quote"
    >
      {content}
    </Pressable>
  ) : (
    <View
      accessible
      accessibilityLabel={label}
      style={[styles.quote, align === 'right' && styles.right]}
      testID="botGroup.quote"
    >
      {content}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  // Same rail as a Markdown quote in group messages (BotGroupMessageText).
  quote: { maxWidth: '86%', borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.md, gap: 2 },
  right: { alignSelf: 'flex-end' },
  // Inside a private-chat bubble the quote spans the bubble's text column.
  fill: { maxWidth: '100%' },
  pressed: { opacity: 0.72 },
  author: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  excerpt: { color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
  deleted: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
});
