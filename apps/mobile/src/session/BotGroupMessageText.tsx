/**
 * 群正文按需启用富文本和 HTTP(S) 链接；其它回看入口保持轻量，本人消息保留原文。
 */
import { botGroupBodyParts } from '@cindy/maker-shared/botGroupPresentation';
import type { BotGroupAuthorKind } from '@cindy/maker-shared/botGroupChat';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { latexToUnicodeApproximation } from '@cindy/maker-shared/math-markdown';
import { splitBotGroupMentionSegments } from '@cindy/maker-shared/botGroupMentions';
import { Text } from '@/components/AppText';
import { MarkdownSelectableText, MarkdownSelectableSpan } from './MarkdownSelectableText';
import { fontWeight, monoFont, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { parseMobileMarkdown, type MobileMarkdownBlock, type MobileMarkdownInline } from './messageMarkdown';
import { buildMessageContentLayout } from './messageContentLayout';
import { buildMobileMarkdownTableColumnWidths } from './messageTableLayout';
import { HighlightedCodeText } from './HighlightedCodeText';
import { MarkdownCodeCopyButton } from './MarkdownCodeCopyButton';
import { MermaidDiagramWebView } from './mermaidWebView';
import { MathFormulaWebView } from './mathWebView';

type Styles = ReturnType<typeof makeStyles>;
type BodyOptions = {
  /** 仅完整群正文启用，其它回看入口维持原行为。 */
  richContent?: boolean;
  active?: boolean;
  interactive?: boolean;
  onOpenDiagram?: (source: string) => void;
};

function renderInlines(inlines: readonly MobileMarkdownInline[], styles: Styles, options: BodyOptions): ReactNode[] {
  const Span = Platform.OS === 'ios' ? MarkdownSelectableSpan : Text;
  return inlines.map((inline, index) => {
    if (inline.marks?.length) {
      const markStyles = { strong: styles.strong, emphasis: styles.emphasis, strikethrough: styles.strike };
      return (
        <Span key={index} style={inline.marks.map((mark) => markStyles[mark])}>
          {inline.type === 'link' && !options.richContent ? inline.text : renderInlines([{ ...inline, marks: undefined }], styles, options)}
        </Span>
      );
    }
    switch (inline.type) {
      case 'strong': return <Span key={index} style={styles.strong}>{inline.text}</Span>;
      case 'emphasis': return <Span key={index} style={styles.emphasis}>{inline.text}</Span>;
      case 'strikethrough': return <Span key={index} style={styles.strike}>{inline.text}</Span>;
      case 'code': return <Span key={index} style={styles.inlineCode}>{inline.text}</Span>;
      case 'link': {
        const clickable = options.richContent && options.interactive !== false && /^https?:\/\//i.test(inline.url);
        return <Span key={index} style={clickable ? styles.link : undefined}
          onPress={clickable ? () => { void Linking.openURL(inline.url).catch(() => undefined); } : undefined}>{inline.text}</Span>;
      }
      case 'math': return <Span key={index}>{options.richContent ? latexToUnicodeApproximation(inline.text) : inline.text}</Span>;
      case 'image': return <Span key={index}>{inline.alt ? `[${inline.alt}]` : ''}</Span>;
      default: return <Span key={index}>{inline.text}</Span>;
    }
  });
}

function BotGroupMarkdownTable({ block, styles, options }: {
  block: Extract<MobileMarkdownBlock, { type: 'table' }>;
  styles: Styles;
  options: BodyOptions;
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
            {renderInlines(cells[index] ?? [], styles, options)}
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

function renderBlock(block: MobileMarkdownBlock, styles: Styles, options: BodyOptions, diagramLabel: string): ReactNode {
  switch (block.type) {
    case 'heading':
      return <MarkdownSelectableText key={block.key} selectable style={[styles.text, styles.heading]}>{renderInlines(block.inlines, styles, options)}</MarkdownSelectableText>;
    case 'blockquote':
      return <View key={block.key} style={styles.quote}>
        <MarkdownSelectableText selectable style={[styles.text, styles.quoteText]}>{renderInlines(block.inlines, styles, options)}</MarkdownSelectableText>
      </View>;
    case 'list_item':
      return <View key={block.key} style={styles.listItem}>
        <Text style={styles.text}>{block.checked === undefined ? (block.ordered ? block.marker : '•') : block.checked ? '☑' : '☐'}</Text>
        <MarkdownSelectableText selectable style={[styles.text, styles.listText]}>{renderInlines(block.inlines, styles, options)}</MarkdownSelectableText>
      </View>;
    case 'code':
      if (options.richContent) {
        const copyable = options.interactive !== false && block.text.trim().length > 0;
        return <View key={block.key} style={[styles.codeBlock, copyable && styles.codeWithCopy]}>
          <HighlightedCodeText text={block.text} language={block.language} styles={styles} selectable allowIosUITextView
            SpanComponent={Platform.OS === 'ios' ? MarkdownSelectableSpan : Text} />
          {copyable ? <MarkdownCodeCopyButton text={block.text} /> : null}
        </View>;
      }
      return renderSourceBlock(block, styles);
    case 'mermaid':
      if (options.richContent) return <View key={block.key}>
        <MermaidDiagramWebView active={options.active} source={block.text} cachePreview testID="botGroup.mermaidDiagram" />
        {options.onOpenDiagram && options.interactive !== false ? <Pressable
          accessibilityLabel={diagramLabel} accessibilityRole="button" style={StyleSheet.absoluteFill}
          onPress={() => options.onOpenDiagram?.(block.text)} testID="botGroup.openDiagram" /> : null}
      </View>;
      return renderSourceBlock(block, styles);
    case 'math':
      if (options.richContent) return <MathFormulaWebView active={options.active} key={block.key} source={block.text} testID="botGroup.mathFormula" />;
      return renderSourceBlock(block, styles);
    case 'table':
      return <BotGroupMarkdownTable key={block.key} block={block} styles={styles} options={options} />;
    default:
      return <MarkdownSelectableText key={block.key} selectable style={styles.text}>{renderInlines(block.inlines, styles, options)}</MarkdownSelectableText>;
  }
}

function renderSourceBlock(block: { key: string; text: string }, styles: Styles) {
  return <View key={block.key} style={styles.codeBlock}>
    <MarkdownSelectableText selectable style={styles.markdownCodeText}>{block.text}</MarkdownSelectableText>
  </View>;
}

export function BotGroupMarkdownText({ content, authorKind, richContent = false, interactive = true, active = true, onOpenDiagram }: {
  content: string; authorKind?: BotGroupAuthorKind;
} & BodyOptions) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const blocks = useMemo(() => botGroupBodyParts(content, authorKind).flatMap((part, index): MobileMarkdownBlock[] => part.kind === 'markdown'
    ? parseMobileMarkdown(part.content).map(block => ({ ...block, key: `${index}:${block.key}` }))
    : [{ type: 'paragraph', key: String(index), inlines: [{ type: 'text', text: part.content }] }]), [content, authorKind]);
  const options = { richContent, interactive, active, onOpenDiagram };
  const diagramLabel = t('message.renderer.openDiagramDetail');
  return <View style={styles.body}>{blocks.map((block) => renderBlock(block, styles, options, diagramLabel))}</View>;
}

/** The user's own words: plain text with `@name` shown as a mention mark. */
export function BotGroupUserText({ content, mentionLabels }: { content: string; mentionLabels: readonly string[] }) {
  const Span = Platform.OS === 'ios' ? MarkdownSelectableSpan : Text;
  const styles = useThemedStyles(makeStyles);
  const segments = useMemo(() => splitBotGroupMentionSegments(content, mentionLabels), [content, mentionLabels]);
  return <MarkdownSelectableText selectable style={styles.text}>
    {segments.map((segment, index) => segment.mention
      ? <Span key={index} style={styles.mention}>{segment.text}</Span>
      : <Span key={index}>{segment.text}</Span>)}
  </MarkdownSelectableText>;
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
  inlineCode: { fontFamily: monoFont, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodyLarge, backgroundColor: colors.surfaceChip },
  quote: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.md },
  quoteText: { color: colors.textSecondary },
  listItem: { flexDirection: 'row', gap: spacing.sm },
  listText: { flex: 1, minWidth: 0 },
  codeBlock: { backgroundColor: colors.chatCodeSurface, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.control, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  markdownCodeText: { color: colors.textPrimary, fontFamily: monoFont, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, flexShrink: 1, maxWidth: '100%' },
  codeWithCopy: { paddingRight: spacing.sm + spacing.xxl + spacing.md, minHeight: spacing.sm + spacing.xxl + spacing.sm },
  syntaxKeyword: { color: colors.syntaxKeyword },
  syntaxString: { color: colors.syntaxString },
  syntaxComment: { color: colors.syntaxComment },
  syntaxNumber: { color: colors.syntaxNumber },
  syntaxFunction: { color: colors.syntaxFunction },
  syntaxProperty: { color: colors.syntaxProperty },
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
  // Match desktop's text-only mention highlight without a chip fill.
  mention: { fontWeight: fontWeight.medium },
});
