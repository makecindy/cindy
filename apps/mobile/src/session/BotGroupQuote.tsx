/**
 * 群聊「引用回复」的引用块（docs/product-rules/bot-group-chat.md §10「引用回复」）。
 * 手机只显示：作者与一到两行摘要，竖线与 Markdown 引用同一样式；原消息已删除时只显示
 * 作者与「原消息已删除」。发起引用与跳转原消息目前只在电脑上。
 */
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BotGroupQuoteDisplay } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, spacing, typeScale } from '@/theme/tokens';

export function BotGroupQuote({ display, align = 'left' }: { display: BotGroupQuoteDisplay; align?: 'left' | 'right' }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const deleted = display.state === 'deleted';
  const summary = deleted
    ? t('groupChat.quote.deleted')
    : display.excerpt || (display.attachmentName && display.attachmentCount > 1
      ? t('groupChat.quote.attachments', { name: display.attachmentName, total: display.attachmentCount })
      : display.attachmentName ?? '');
  return (
    <View
      accessible
      accessibilityLabel={t('groupChat.quote.label', { name: display.authorName, summary })}
      style={[styles.quote, align === 'right' && styles.right]}
      testID="botGroup.quote"
    >
      <Text numberOfLines={1} style={styles.author}>{display.authorName}</Text>
      <Text numberOfLines={2} style={deleted ? styles.deleted : styles.excerpt}>{summary}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  // Same rail as a Markdown quote in group messages (BotGroupMessageText).
  quote: { maxWidth: '86%', borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.md, gap: 2 },
  right: { alignSelf: 'flex-end' },
  author: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  excerpt: { color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular },
  deleted: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
});
