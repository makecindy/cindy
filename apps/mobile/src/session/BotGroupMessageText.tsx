import { useWindowWidth } from '@/platform/windowDimension';
import type { ViewInstance } from 'react-native';
/**
 * 群正文按需启用富文本和 HTTP(S) 链接；其它回看入口保持轻量，本人消息保留原文。
 */
import { botGroupBodyParts } from '@cindy/maker-shared/botGroupPresentation';
import type { BotGroupAuthorKind } from '@cindy/maker-shared/botGroupChat';
import { memo, useContext, useId, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Pressable, Platform, ScrollView, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent, type StyleProp, type TextStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { tokenizeInlineMath } from '@cindy/maker-shared/math-markdown';
import { HighlightedCodeText } from './HighlightedCodeText';
import { MarkdownCodeCopyButton } from './MarkdownCodeCopyButton';
import { MermaidDiagramWebView } from './mermaidWebView';
import { MathFormulaWebView } from './mathWebView';
import { hasRichAnswer } from '@cindy/maker-shared/rich-answer';
import { splitBotGroupMentionSegments, type BotGroupTextSegment } from '@cindy/maker-shared/botGroupMentions';
import { Text } from '@/components/AppText';
import { MarkdownSelectableText, MarkdownSelectableSpan } from './MarkdownSelectableText';
import { fontWeight, monoFont, useThemedStyles, type ThemeColors } from '@/theme';
import { lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { mobileMarkdownListMarkerText, parseMobileMarkdown, type MobileMarkdownBlock, type MobileMarkdownInline } from './messageMarkdown';
import { buildMessageContentLayout } from './messageContentLayout';
import { buildMobileMarkdownTableColumnWidths } from './messageTableLayout';
import { botGroupMentionMember, type BotGroupMentionContext, type BotGroupMentionPoint } from './botGroupMentions';
import { MarkdownBody, MessagePayloadModal, MessageHeavyContentVisibilityContext } from './MessageRenderer';
import { ImageLightbox } from './ImageLightbox';
import type { MessagePayload } from './messagePayload';
import { ChatFilePathContext } from './chatFilePathContext';
import { SessionQuickSendProvider, useSessionQuickSend } from './SessionQuickSendContext';
import { MessageListVisibilityContext, useMessageListItemVisible } from './messageListVisibility';

type Styles = ReturnType<typeof makeStyles>;
type BodyOptions = {
  /** 仅完整群正文启用，其它回看入口维持原行为。 */
  richContent?: boolean;
  active?: boolean;
  interactive?: boolean;
  onOpenDiagram?: (source: string) => void;
};


/** Observe touches without claiming the responder or changing the native text tree. */
function useMentionTouchContext(context?: BotGroupMentionContext) {
  const touch = useRef<BotGroupMentionPoint | undefined>(undefined);
  const body = useRef<ViewInstance>(null);
  const onTouchStart = useCallback((event: GestureResponderEvent) => {
      const { pageX, pageY } = event.nativeEvent;
      touch.current = Number.isFinite(pageX) && Number.isFinite(pageY) ? { x: pageX, y: pageY } : undefined;
  }, []);
  const onPress = context?.onPress;
  const anchoredPress = useCallback<BotGroupMentionContext['onPress']>((member, anchor) => {
      const point = touch.current ?? anchor;
      touch.current = undefined;
      if (point) onPress?.(member, point);
      else {
        // Accessibility activation has no finger position. Anchor to the
        // measured sent-text bounds instead of dropping the link activation.
        const target = body.current;
        target?.measureInWindow((x, y, width, height) => {
          if (body.current === target && width > 0 && height > 0) {
            onPress?.(member, { x: x + width / 2, y: y + height / 2 });
          }
        });
      }
  }, [onPress]);
  const { members, mentions, serverBacked, allLabels, allBotsLabels, labels } = context ?? {};
  const anchored = useMemo(() => members && mentions && allLabels && allBotsLabels && labels
    ? { members, mentions, serverBacked: !!serverBacked, allLabels, allBotsLabels, labels, onPress: anchoredPress }
    : undefined, [members, mentions, serverBacked, allLabels, allBotsLabels, labels, anchoredPress]);
  return { ref: body, onTouchStart, context: anchored };
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

function inlineMathSubFontSize(baseFontSize: number): number {
  if (baseFontSize <= typeScale.bodySmall) return typeScale.micro;
  if (baseFontSize <= typeScale.subtitle) return typeScale.caption;
  return typeScale.footnote;
}

function renderInlines(inlines: readonly MobileMarkdownInline[], styles: Styles, options: BodyOptions, context?: BotGroupMentionContext, baseFontSize: number = typeScale.bodyLarge): ReactNode[] {
  const Span = Platform.OS === 'ios' ? MarkdownSelectableSpan : Text;
  const markStyles = { strong: styles.strong, emphasis: styles.emphasis, strikethrough: styles.strike };
  let offset = 0;
  const runs = inlines.map(inline => {
    const mathSegments = inline.type === 'math' && options.richContent ? tokenizeInlineMath(inline.text) : null;
    const text = inline.type === 'image' ? inline.alt ? `[${inline.alt}]` : ''
      : mathSegments ? mathSegments.map(segment => segment.text).join('') : inline.text;
    const start = offset;
    offset += text.length;
    return { inline, mathSegments, text, start, end: offset, excluded: ['code', 'link', 'image', 'math'].includes(inline.type) };
  });
  offset = 0;
  // Match the whole visible word before mapping back to styled native runs:
  // **@Ann**a is @Anna, and mail**@Ann**.test is still an email address.
  const visibleText = runs.map(run => run.text).join('');
  // Most group text has no mention. Keep its native styled run directly:
  // scanning labels and nesting another selectable span adds work per cell/run.
  const segments = context && visibleText.includes('@') ? splitBotGroupMentionSegments(visibleText, context.labels).map(segment => {
    const start = offset;
    offset += segment.text.length;
    return { ...segment, start, end: offset, label: segment.text,
      mention: segment.mention && !runs.some(run => run.excluded && run.start < offset && run.end > start) };
  }) : null;
  return runs.map(({ inline, mathSegments, text, start, end, excluded }, index) => {
    const textStyle = [...(inline.marks?.map(mark => markStyles[mark]) ?? []),
      inline.type === 'strong' ? styles.strong : inline.type === 'emphasis' ? styles.emphasis
        : inline.type === 'strikethrough' ? styles.strike : inline.type === 'code' ? styles.inlineCode : undefined];
    if (mathSegments) {
      const subFontSize = inlineMathSubFontSize(baseFontSize);
      return (
        <Span key={index} style={textStyle}>
          {mathSegments.map((segment, segIndex) => (
            <Span
              key={`${index}:${segIndex}`}
              style={[
                ...textStyle,
                segment.kind === 'var'
                  ? styles.mathVar
                  : segment.kind === 'sup'
                    ? styles.mathSup
                    : segment.kind === 'sub'
                      ? [segment.italic ? styles.mathVar : styles.mathText, { fontSize: subFontSize }]
                      : styles.mathText,
              ]}
            >
              {segment.text}
            </Span>
          ))}
        </Span>
      );
    }
    if (inline.type === 'link') {
      const clickable = options.richContent && options.interactive !== false && /^https?:\/\//i.test(inline.url);
      return <Span key={index} style={[textStyle, clickable && styles.link]}
        onPress={clickable ? () => { void Linking.openURL(inline.url).catch(() => undefined); } : undefined}>{text}</Span>;
    }
    // UITextView children inherit the root's style, not an enclosing span's.
    // Keep formatting on each actual text run when splitting it around a mention.
    // Code and existing links retain their original hierarchy and are never identity targets.
    return <Span key={index} style={textStyle}>{excluded || !segments ? text : renderMentionSegments(segments.flatMap(segment => {
      const from = Math.max(start, segment.start);
      const to = Math.min(end, segment.end);
      return from < to ? [{ text: segment.text.slice(from - segment.start, to - segment.start), mention: segment.mention, label: segment.label }] : [];
    }), styles, context, textStyle)}</Span>;
  });
}

function BotGroupMarkdownTable({ block, styles, options, context }: {
  block: Extract<MobileMarkdownBlock, { type: 'table' }>;
  styles: Styles;
  options: BodyOptions;
  context?: BotGroupMentionContext;
}) {
  const screenWidth = useWindowWidth();
  const [availableWidth, setAvailableWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailableWidth(event.nativeEvent.layout.width);
  }, []);
  // This read-only renderer shows image alt text, so measure that same text, not a preview.
  const measured = useMemo(() => {
    const measureCells = (cells: readonly MobileMarkdownInline[][]) => cells.map(cell => cell.map(
      (inline): MobileMarkdownInline => inline.type === 'image'
        ? { type: 'text', text: inline.alt ? `[${inline.alt}]` : '' }
        : inline,
    ));
    return { header: measureCells(block.header), rows: block.rows.map(row => ({ ...row, cells: measureCells(row.cells) })) };
  }, [block]);
  const minWidth = buildMessageContentLayout({ screenWidth }).markdownTableCellMinWidth;
  const widths = useMemo(() => buildMobileMarkdownTableColumnWidths({ ...measured, availableWidth, minWidth }),
    [measured, availableWidth, minWidth]);
  const renderRow = (cells: readonly MobileMarkdownInline[][], key: string, header = false) => (
    <View key={key} style={[styles.tableRow, header && styles.tableHeaderRow]}>
      {widths.map((width, index) => (
        <View key={index} style={[styles.tableCell, { width }]}>
          <MarkdownSelectableText selectable style={[styles.tableText, header && styles.tableHeaderText]}>
            {renderInlines(cells[index] ?? [], styles, options, context, typeScale.bodySmall)}
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

function renderBlock(block: MobileMarkdownBlock, styles: Styles, options: BodyOptions, diagramLabel: string, context?: BotGroupMentionContext): ReactNode {
  switch (block.type) {
    case 'heading':
      return <MarkdownSelectableText key={block.key} selectable style={[styles.text, styles.heading]}>{renderInlines(block.inlines, styles, options, context)}</MarkdownSelectableText>;
    case 'blockquote':
      return <View key={block.key} style={styles.quote}>
        <MarkdownSelectableText selectable style={[styles.text, styles.quoteText]}>{renderInlines(block.inlines, styles, options, context)}</MarkdownSelectableText>
      </View>;
    case 'list_item':
      return <View key={block.key} style={[styles.listItem, { paddingLeft: (block.depth ?? 0) * typeScale.bodyLarge }]}>
        <Text style={styles.text}>{mobileMarkdownListMarkerText(block).trim()}</Text>
        <MarkdownSelectableText selectable style={[styles.text, styles.listText]}>{renderInlines(block.inlines, styles, options, context)}</MarkdownSelectableText>
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
      return <BotGroupMarkdownTable key={block.key} block={block} styles={styles} options={options} context={context} />;
    default:
      return <MarkdownSelectableText key={block.key} selectable style={styles.text}>{renderInlines(block.inlines, styles, options, context)}</MarkdownSelectableText>;
  }
}

function renderSourceBlock(block: { key: string; text: string }, styles: Styles) {
  return <View key={block.key} style={styles.codeBlock}>
    <MarkdownSelectableText selectable style={styles.markdownCodeText}>{block.text}</MarkdownSelectableText>
  </View>;
}

/** Static text does not depend on route visibility. Only embedded renderers
 * receive active changes; native selection/code/table subtrees stay mounted. */
const BotGroupMarkdownBlock = memo(function BotGroupMarkdownBlock({ block, styles, diagramLabel, context, ...options }: {
  block: MobileMarkdownBlock; styles: Styles; diagramLabel: string; context?: BotGroupMentionContext;
} & BodyOptions) {
  return renderBlock(block, styles, options, diagramLabel, context);
});

export function BotGroupMarkdownText({ content, authorKind, mentionContext, richContent = false, interactive = true, active = true, onOpenDiagram, messageKey, messageId, readOnly = false }: {
  content: string; authorKind?: BotGroupAuthorKind; mentionContext?: BotGroupMentionContext;
  messageKey?: string; messageId?: string; readOnly?: boolean;
} & BodyOptions) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const touch = useMentionTouchContext(content.includes('@') ? mentionContext : undefined);
  const width = useWindowWidth();
  const instanceKey = useId();
  const sender = useSessionQuickSend();
  const visibility = useContext(MessageListVisibilityContext);
  const visible = useMessageListItemVisible(messageId ?? instanceKey);
  const [payload, setPayload] = useState<MessagePayload | null>(null);
  const layout = useMemo(() => buildMessageContentLayout({ screenWidth: width }), [width]);
  const rich = authorKind === 'bot' && hasRichAnswer(content);
  const blocks = useMemo(() => rich ? [] : botGroupBodyParts(content, authorKind).flatMap((part, index): MobileMarkdownBlock[] => part.kind === 'markdown'
    ? parseMobileMarkdown(part.content).map(block => ({ ...block, key: `${index}:${block.key}` }))
    : [{ type: 'paragraph', key: String(index), inlines: [{ type: 'text', text: part.content }] }]), [content, authorKind, rich]);
  if (rich) return (
    <SessionQuickSendProvider value={readOnly || !interactive ? null : sender}>
      <MessageHeavyContentVisibilityContext.Provider value={active && (!visibility || visible)}>
        <ChatFilePathContext.Provider value={null}>
          <MarkdownBody renderRichAnswers publicMediaOnly richStateKey={messageKey ?? instanceKey}
            markdownImageCacheKey={messageKey ?? instanceKey} layout={layout} text={content} selectable
            onOpenPayload={next => {
              // Shared answers may open public media and diagrams, never task-local files.
              if (next.kind === 'mermaid' || (next.kind === 'media' && /^https?:\/\//i.test(next.media.url))) setPayload(next);
            }} />
          {payload?.kind === 'media' && payload.media.kind === 'image'
            ? <ImageLightbox images={[{ key: messageKey ?? instanceKey, title: payload.title, url: payload.media.url, payload }]}
                initialUrl={payload.media.url} onClose={() => setPayload(null)} />
            : payload ? <MessagePayloadModal payload={payload} onClose={() => setPayload(null)} /> : null}
        </ChatFilePathContext.Provider>
      </MessageHeavyContentVisibilityContext.Provider>
    </SessionQuickSendProvider>
  );
  const diagramLabel = t('message.renderer.openDiagramDetail');
  return <View ref={touch.ref} collapsable={false} style={styles.body} onTouchStart={touch.onTouchStart}>{blocks.map(block =>
    <BotGroupMarkdownBlock key={block.key} block={block} styles={styles} diagramLabel={diagramLabel}
      context={touch.context} richContent={richContent} interactive={interactive}
      active={block.type === 'mermaid' || block.type === 'math' ? active : undefined}
      onOpenDiagram={block.type === 'mermaid' ? onOpenDiagram : undefined} />)}</View>;
}

/** The user's own words: plain text with `@name` shown as a mention mark. */
export function BotGroupUserText({ content, mentionLabels, mentionContext }: { content: string; mentionLabels: readonly string[]; mentionContext?: BotGroupMentionContext }) {
  const styles = useThemedStyles(makeStyles);
  const touch = useMentionTouchContext(content.includes('@') ? mentionContext : undefined);
  const text = useMemo(() => renderMentionSegments(splitBotGroupMentionSegments(content, mentionLabels), styles, touch.context),
    [content, mentionLabels, styles, touch.context]);
  return <View ref={touch.ref} collapsable={false} onTouchStart={touch.onTouchStart}><MarkdownSelectableText selectable style={styles.text}>
    {text}
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
  mathVar: {
    fontFamily: Platform.select({ ios: 'Times New Roman', android: 'serif', default: 'serif' }),
    fontStyle: 'italic',
  },
  mathText: {
    fontFamily: Platform.select({ ios: 'Times New Roman', android: 'serif', default: 'serif' }),
    fontStyle: 'normal',
  },
  mathSup: {
    fontFamily: Platform.select({ ios: 'Helvetica Neue', android: 'sans-serif', default: undefined }),
    fontStyle: 'normal',
  },
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
  // Same as PC @ ranges: link color only; preserve authored weight and decorations.
  mention: { color: colors.groupMentionText },
});
