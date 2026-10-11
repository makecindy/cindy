/**
 * 群聊消息正文。伙伴的回复是 Markdown：这里只做轻量排版（段落、标题、引用、列表、代码块、
 * 行内强调 / 代码），与伙伴私聊回看同样是只读文本，不加载任务页的完整消息渲染器；链接只
 * 显示文字，不在群聊里打开。用户自己的消息保留原文，`@名字` 画成点名标记。
 */
import { useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { splitBotGroupMentionSegments } from '@cindy/maker-shared/botGroupMentions';
import { Text } from '@/components/AppText';
import { fontWeight, monoFont, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { parseMobileMarkdown, type MobileMarkdownBlock, type MobileMarkdownInline } from './messageMarkdown';

type Styles = ReturnType<typeof makeStyles>;

function renderInlines(inlines: readonly MobileMarkdownInline[], styles: Styles): ReactNode[] {
  return inlines.map((inline, index) => {
    // 强调里的链接 / 代码等:外层套一层带强调样式的 Text,嵌套 Text 继承样式。
    // 删除线里的链接:内层 underline 会盖掉外层 line-through(单值属性),改用合并值。
    if (inline.marks?.length) {
      const markStyles = { strong: styles.strong, emphasis: styles.emphasis, strikethrough: styles.strike };
      return (
        <Text key={index} style={inline.marks.map((mark) => markStyles[mark])}>
          {inline.type === 'link' && inline.marks.includes('strikethrough')
            ? <Text style={styles.linkStrike}>{inline.text}</Text>
            : renderInlines([{ ...inline, marks: undefined }], styles)}
        </Text>
      );
    }
    switch (inline.type) {
      case 'strong': return <Text key={index} style={styles.strong}>{inline.text}</Text>;
      case 'emphasis': return <Text key={index} style={styles.emphasis}>{inline.text}</Text>;
      case 'strikethrough': return <Text key={index} style={styles.strike}>{inline.text}</Text>;
      case 'code': return <Text key={index} style={styles.inlineCode}>{inline.text}</Text>;
      case 'link': return <Text key={index} style={styles.link}>{inline.text}</Text>;
      case 'image': return <Text key={index}>{inline.alt ? `[${inline.alt}]` : ''}</Text>;
      default: return <Text key={index}>{inline.text}</Text>;
    }
  });
}

function tableText(block: Extract<MobileMarkdownBlock, { type: 'table' }>): string {
  const cell = (inlines: readonly MobileMarkdownInline[]) => inlines.map((inline) => inline.type === 'image' ? inline.alt : inline.text).join('');
  return [block.header, ...block.rows.map((row) => row.cells)]
    .map((cells) => cells.map(cell).join(' | '))
    .join('\n');
}

function renderBlock(block: MobileMarkdownBlock, styles: Styles): ReactNode {
  switch (block.type) {
    case 'heading':
      return <Text key={block.key} selectable style={[styles.text, styles.heading]}>{renderInlines(block.inlines, styles)}</Text>;
    case 'blockquote':
      return <View key={block.key} style={styles.quote}>
        <Text selectable style={[styles.text, styles.quoteText]}>{renderInlines(block.inlines, styles)}</Text>
      </View>;
    case 'list_item':
      return <View key={block.key} style={styles.listItem}>
        <Text style={styles.text}>{block.checked === undefined ? (block.ordered ? block.marker : '•') : block.checked ? '☑' : '☐'}</Text>
        <Text selectable style={[styles.text, styles.listText]}>{renderInlines(block.inlines, styles)}</Text>
      </View>;
    case 'code':
    case 'mermaid':
    case 'math':
      return <View key={block.key} style={styles.codeBlock}>
        <Text selectable style={styles.codeText}>{block.text}</Text>
      </View>;
    case 'table':
      return <View key={block.key} style={styles.codeBlock}>
        <Text selectable style={styles.codeText}>{tableText(block)}</Text>
      </View>;
    default:
      return <Text key={block.key} selectable style={styles.text}>{renderInlines(block.inlines, styles)}</Text>;
  }
}

export function BotGroupMarkdownText({ content }: { content: string }) {
  const styles = useThemedStyles(makeStyles);
  const blocks = useMemo(() => parseMobileMarkdown(content), [content]);
  return <View style={styles.body}>{blocks.map((block) => renderBlock(block, styles))}</View>;
}

/** The user's own words: plain text with `@name` shown as a mention mark. */
export function BotGroupUserText({ content, mentionLabels }: { content: string; mentionLabels: readonly string[] }) {
  const styles = useThemedStyles(makeStyles);
  const segments = useMemo(() => splitBotGroupMentionSegments(content, mentionLabels), [content, mentionLabels]);
  return <Text selectable style={styles.text}>
    {segments.map((segment, index) => segment.mention
      ? <Text key={index} style={styles.mention}>{segment.text}</Text>
      : <Text key={index}>{segment.text}</Text>)}
  </Text>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  body: { gap: spacing.sm, minWidth: 0 },
  // Conversation message body (mobile guide §3): 17 / 26 regular.
  text: { color: colors.textPrimary, fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge },
  heading: { fontWeight: fontWeight.semibold },
  strong: { fontWeight: fontWeight.semibold },
  emphasis: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { textDecorationLine: 'underline' },
  linkStrike: { textDecorationLine: 'underline line-through' },
  inlineCode: { fontFamily: monoFont, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodyLarge, backgroundColor: colors.surfaceChip },
  quote: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.md },
  quoteText: { color: colors.textSecondary },
  listItem: { flexDirection: 'row', gap: spacing.sm },
  listText: { flex: 1, minWidth: 0 },
  codeBlock: { backgroundColor: colors.chatCodeSurface, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.control, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  codeText: { color: colors.textPrimary, fontFamily: monoFont, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  mention: { fontWeight: fontWeight.medium, backgroundColor: colors.surfaceChip },
});
