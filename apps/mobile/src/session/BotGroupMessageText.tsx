/**
 * 群聊消息正文。伙伴的回复是 Markdown：这里只做轻量排版（段落、标题、引用、列表、代码块、
 * 表格、行内强调 / 代码），与伙伴私聊回看同样是只读文本，不加载任务页的完整消息渲染器；链接只
 * 显示文字，不在群聊里打开。用户自己的消息保留原文，`@名字` 画成点名标记。
 */
import { botGroupBodyParts } from '@cindy/maker-shared/botGroupPresentation';
import type { BotGroupAuthorKind } from '@cindy/maker-shared/botGroupChat';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, View, useWindowDimensions, type GestureResponderEvent, type LayoutChangeEvent, type StyleProp, type TextStyle } from 'react-native';
import { splitBotGroupMentionSegments, type BotGroupTextSegment } from '@cindy/maker-shared/botGroupMentions';
import { Text } from '@/components/AppText';
import { MarkdownSelectableText, MarkdownSelectableSpan } from './MarkdownSelectableText';
import { fontWeight, monoFont, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { parseMobileMarkdown, type MobileMarkdownBlock, type MobileMarkdownInline } from './messageMarkdown';
import { buildMessageContentLayout } from './messageContentLayout';
import { buildMobileMarkdownTableColumnWidths } from './messageTableLayout';
import { botGroupMentionMember, type BotGroupMentionContext, type BotGroupMentionPoint } from './botGroupMentions';

type Styles = ReturnType<typeof makeStyles>;

/** Observe touches without claiming the responder or changing the native text tree. */
function useMentionTouchContext(context?: BotGroupMentionContext) {
  const touch = useRef<BotGroupMentionPoint | undefined>(undefined);
  const body = useRef<View>(null);
  return {
    ref: body,
    onTouchStart: (event: GestureResponderEvent) => {
      const { pageX, pageY } = event.nativeEvent;
      touch.current = Number.isFinite(pageX) && Number.isFinite(pageY) ? { x: pageX, y: pageY } : undefined;
    },
    context: context ? { ...context, onPress: (member, anchor) => {
      const point = touch.current ?? anchor;
      touch.current = undefined;
      if (point) context.onPress(member, point);
      else {
        // Accessibility activation has no finger position. Anchor to the
        // measured sent-text bounds instead of dropping the link activation.
        const target = body.current;
        target?.measureInWindow((x, y, width, height) => {
          if (body.current === target && width > 0 && height > 0) {
            context.onPress(member, { x: x + width / 2, y: y + height / 2 });
          }
        });
      }
    } } as BotGroupMentionContext : undefined,
  };
}

function renderMentionSegments(segments: readonly (BotGroupTextSegment & { label?: string })[], styles: Styles, context?: BotGroupMentionContext, textStyle?: StyleProp<TextStyle>): ReactNode {
  const Span = Platform.OS === 'ios' ? MarkdownSelectableSpan : Text;
  return segments.map((segment, index) => {
    const member = segment.mention && context ? botGroupMentionMember(segment.label ?? segment.text, context) : undefined;
    return <Span key={index} style={[textStyle, segment.mention && styles.mention]}
      accessibilityRole={member ? 'link' : undefined}
      onPress={member ? event => { event.stopPropagation(); context?.onPress(member); } : undefined}>{segment.text}</Span>;
  });
}

function renderInlines(inlines: readonly MobileMarkdownInline[], styles: Styles, context?: BotGroupMentionContext): ReactNode[] {
  const Span = Platform.OS === 'ios' ? MarkdownSelectableSpan : Text;
  const markStyles = { strong: styles.strong, emphasis: styles.emphasis, strikethrough: styles.strike };
  let offset = 0;
  const runs = inlines.map(inline => {
    const text = inline.type === 'image' ? inline.alt ? `[${inline.alt}]` : '' : inline.text;
    const start = offset;
    offset += text.length;
    return { inline, text, start, end: offset, excluded: ['code', 'link', 'image'].includes(inline.type) };
  });
  offset = 0;
  // Match the whole visible word before mapping back to styled native runs:
  // **@Ann**a is @Anna, and mail**@Ann**.test is still an email address.
  const segments = splitBotGroupMentionSegments(runs.map(run => run.text).join(''), context?.labels ?? []).map(segment => {
    const start = offset;
    offset += segment.text.length;
    return { ...segment, start, end: offset, label: segment.text,
      mention: segment.mention && !runs.some(run => run.excluded && run.start < offset && run.end > start) };
  });
  return runs.map(({ inline, text, start, end, excluded }, index) => {
    const textStyle = [...(inline.marks?.map(mark => markStyles[mark]) ?? []),
      inline.type === 'strong' ? styles.strong : inline.type === 'emphasis' ? styles.emphasis
        : inline.type === 'strikethrough' ? styles.strike : inline.type === 'code' ? styles.inlineCode : undefined];
    // UITextView children inherit the root's style, not an enclosing span's.
    // Keep formatting on each actual text run when splitting it around a mention.
    // Code and existing links retain their original hierarchy and are never identity targets.
    return <Span key={index} style={textStyle}>{excluded || !context ? text : renderMentionSegments(segments.flatMap(segment => {
      const from = Math.max(start, segment.start);
      const to = Math.min(end, segment.end);
      return from < to ? [{ text: segment.text.slice(from - segment.start, to - segment.start), mention: segment.mention, label: segment.label }] : [];
    }), styles, context, textStyle)}</Span>;
  });
}

function BotGroupMarkdownTable({ block, styles, context }: {
  block: Extract<MobileMarkdownBlock, { type: 'table' }>;
  styles: Styles;
  context?: BotGroupMentionContext;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const [availableWidth, setAvailableWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailableWidth(event.nativeEvent.layout.width);
  }, []);
  // This read-only renderer shows image alt text, so measure that same text, not a preview.
  const measureCells = (cells: readonly MobileMarkdownInline[][]) => cells.map(cell => cell.map(
    (inline): MobileMarkdownInline => inline.type === 'image'
      ? { type: 'text', text: inline.alt ? `[${inline.alt}]` : '' }
      : inline,
  ));
  const widths = buildMobileMarkdownTableColumnWidths({
    header: measureCells(block.header), rows: block.rows.map(row => ({ ...row, cells: measureCells(row.cells) })), availableWidth,
    minWidth: buildMessageContentLayout({ screenWidth }).markdownTableCellMinWidth,
  });
  const renderRow = (cells: readonly MobileMarkdownInline[][], key: string, header = false) => (
    <View key={key} style={[styles.tableRow, header && styles.tableHeaderRow]}>
      {widths.map((width, index) => (
        <View key={index} style={[styles.tableCell, { width }]}>
          <MarkdownSelectableText selectable style={[styles.tableText, header && styles.tableHeaderText]}>
            {renderInlines(cells[index] ?? [], styles, context)}
          </MarkdownSelectableText>
        </View>
      ))}
    </View>
  );
  return <ScrollView horizontal style={styles.tableScroll} onLayout={onLayout}>
    <View style={styles.table}>
      {renderRow(block.header, `${block.key}:header`, true)}
      {block.rows.map(row => renderRow(row.cells, row.key))}
    </View>
  </ScrollView>;
}

function renderBlock(block: MobileMarkdownBlock, styles: Styles, context?: BotGroupMentionContext): ReactNode {
  switch (block.type) {
    case 'heading':
      return <MarkdownSelectableText key={block.key} selectable style={[styles.text, styles.heading]}>{renderInlines(block.inlines, styles, context)}</MarkdownSelectableText>;
    case 'blockquote':
      return <View key={block.key} style={styles.quote}>
        <MarkdownSelectableText selectable style={[styles.text, styles.quoteText]}>{renderInlines(block.inlines, styles, context)}</MarkdownSelectableText>
      </View>;
    case 'list_item':
      return <View key={block.key} style={styles.listItem}>
        <Text style={styles.text}>{block.checked === undefined ? (block.ordered ? block.marker : '•') : block.checked ? '☑' : '☐'}</Text>
        <MarkdownSelectableText selectable style={[styles.text, styles.listText]}>{renderInlines(block.inlines, styles, context)}</MarkdownSelectableText>
      </View>;
    case 'code':
    case 'mermaid':
    case 'math':
      return <View key={block.key} style={styles.codeBlock}>
        <MarkdownSelectableText selectable style={styles.codeText}>{block.text}</MarkdownSelectableText>
      </View>;
    case 'table':
      return <BotGroupMarkdownTable key={block.key} block={block} styles={styles} context={context} />;
    default:
      return <MarkdownSelectableText key={block.key} selectable style={styles.text}>{renderInlines(block.inlines, styles, context)}</MarkdownSelectableText>;
  }
}

export function BotGroupMarkdownText({ content, authorKind, mentionContext }: { content: string; authorKind?: BotGroupAuthorKind; mentionContext?: BotGroupMentionContext }) {
  const styles = useThemedStyles(makeStyles);
  const touch = useMentionTouchContext(mentionContext);
  const blocks = useMemo(() => botGroupBodyParts(content, authorKind).flatMap((part, index): MobileMarkdownBlock[] => part.kind === 'markdown'
    ? parseMobileMarkdown(part.content).map(block => ({ ...block, key: `${index}:${block.key}` }))
    : [{ type: 'paragraph', key: String(index), inlines: [{ type: 'text', text: part.content }] }]), [content, authorKind]);
  return <View ref={touch.ref} collapsable={false} style={styles.body} onTouchStart={touch.onTouchStart}>{blocks.map((block) => renderBlock(block, styles, touch.context))}</View>;
}

/** The user's own words: plain text with `@name` shown as a mention mark. */
export function BotGroupUserText({ content, mentionLabels, mentionContext }: { content: string; mentionLabels: readonly string[]; mentionContext?: BotGroupMentionContext }) {
  const styles = useThemedStyles(makeStyles);
  const touch = useMentionTouchContext(mentionContext);
  return <View ref={touch.ref} collapsable={false} onTouchStart={touch.onTouchStart}><MarkdownSelectableText selectable style={styles.text}>
    {renderMentionSegments(splitBotGroupMentionSegments(content, mentionLabels), styles, touch.context)}
  </MarkdownSelectableText></View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  body: { gap: spacing.sm, minWidth: 0 },
  // Conversation message body (mobile guide §3): 17 / 26 regular.
  text: { color: colors.textPrimary, fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge },
  heading: { fontWeight: fontWeight.semibold },
  strong: { fontWeight: fontWeight.semibold },
  emphasis: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  inlineCode: { fontFamily: monoFont, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodyLarge, backgroundColor: colors.surfaceChip },
  quote: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.md },
  quoteText: { color: colors.textSecondary },
  listItem: { flexDirection: 'row', gap: spacing.sm },
  listText: { flex: 1, minWidth: 0 },
  codeBlock: { backgroundColor: colors.chatCodeSurface, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.control, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  codeText: { color: colors.textPrimary, fontFamily: monoFont, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  tableScroll: { maxWidth: '100%' },
  table: { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, overflow: 'hidden' },
  tableRow: { flexDirection: 'row' },
  tableHeaderRow: { backgroundColor: colors.surfaceElevated },
  tableCell: { flexShrink: 0, borderRightColor: colors.border, borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  tableText: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  tableHeaderText: { color: colors.textSecondary, fontWeight: fontWeight.medium },
  // Same as PC @ ranges: link color only; preserve authored weight and decorations.
  mention: { color: colors.groupMentionText },
});
