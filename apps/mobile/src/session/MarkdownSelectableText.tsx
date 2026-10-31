import { useContext, useRef, type ComponentProps } from 'react';
import { Platform, StyleSheet, useWindowDimensions, type GestureResponderEvent, type StyleProp, type TextStyle } from 'react-native';
import { UITextView } from 'react-native-uitextview';
import { MAX_FONT_SIZE_MULTIPLIER, Text } from '@/components/AppText';
import { i18n } from '@/i18n';
import { SelectionMenuText } from './SelectionMenuText';
import { useCancelShareSelectionRowTap } from './ShareMessageCheckbox';
import { selectableTextVerticalOffset } from './selectableTextAlignment';
import { SelectionQuoteContext, handleSelectionQuoteMenuAction, selectionQuoteMenuLabel } from './selectionQuote';

/**
 * Shared message selection: iOS uses UITextView for native range handles (RN
 * Text only copies whole blocks); Android retains its native selectable Text.
 * Leave selection highlighting to the platform (#1427).
 */
type MarkdownSelectableTextProps = Omit<ComponentProps<typeof Text>, 'selectionColor'> & {
  /**
   * iOS 是否使用可部分选中的 UITextView。普通任务的超长展开正文回退 RN Text:
   * UITextView 在折叠→展开时骤增为超高复用视图会偶发只留下巨高空白容器。
   */
  allowIosUITextView?: boolean;
  /** Decorated table cells must stay on the row grid, including their borders. */
  adjustVerticalAlignment?: boolean;
  /** Include larger inline headings when aligning a combined text run. */
  alignmentTextStyles?: readonly StyleProp<TextStyle>[];
};

export function MarkdownSelectableText({
  allowIosUITextView = true,
  adjustVerticalAlignment = true,
  alignmentTextStyles,
  selectable,
  ...rest
}: MarkdownSelectableTextProps) {
  // chat-text-quote:宿主(MessageRenderer)启用采集时,给 iOS UITextView 传
  // menuActionLabel(系统选择菜单里插入「添加到对话」项,iOS 16+)并挂
  // onTextLayout(缓存逐行渲染文本)+ onMenuAction(菜单点按时按选区偏移切
  // 文本提交)。context 为 null(宿主未启用 / 非会话场景)时零开销走原路径。
  const quoteCtx = useContext(SelectionQuoteContext);
  const renderedLinesRef = useRef<readonly string[]>([]);
  const { fontScale } = useWindowDimensions();
  if (selectable && allowIosUITextView && Platform.OS === 'ios') {
    const typography = [rest.style, ...(alignmentTextStyles ?? [])]
      .map((style) => StyleSheet.flatten(style) ?? {});
    const top = selectableTextVerticalOffset(typography, rest.allowFontScaling === false ? 1 : fontScale);
    // Position only the selectable root. RN Text already centers its leading;
    // shifting the bubble itself would also shift pending/Android text and chips.
    const alignedStyle: StyleProp<TextStyle> = adjustVerticalAlignment ? [rest.style, { top }] : rest.style;
    if (!quoteCtx) {
      return (
        <UITextView
          maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
          selectable
          uiTextView
          {...rest}
          style={alignedStyle}
        />
      );
    }
    return (
      <UITextView
        maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
        selectable
        uiTextView
        {...rest}
        style={alignedStyle}
        onTextLayout={(e) => {
          // uitextview 自定义 spec 的 lines 是 string[](RN 核心 Text 是对象数组),
          // 双形态防御:确保缓存的是纯字符串行。
          const rawLines = e.nativeEvent.lines as unknown as readonly (string | { text: string })[];
          renderedLinesRef.current = rawLines.map((line) => (typeof line === 'string' ? line : line.text));
          rest.onTextLayout?.(e);
        }}
        // menuActionLabel / onMenuAction 是 uitextview patch 的扩展 prop,不在
        // RN Text props 里,组件内部私有附加(经 {...rest} 透传到原生组件)。
        {...{
          menuActionLabel: selectionQuoteMenuLabel(),
          sideChatMenuActionLabel: quoteCtx.askInSideChat ? i18n.t('session.sideChat.title') : '',
          onMenuAction: (event: { nativeEvent: { target: number; start: number; end: number } }) => {
            handleSelectionQuoteMenuAction(event, renderedLinesRef.current, quoteCtx);
          },
          onSideChatMenuAction: (event: { nativeEvent: { target: number; start: number; end: number } }) => {
            handleSelectionQuoteMenuAction(event, renderedLinesRef.current, quoteCtx, 'side-chat');
          },
        }}
      />
    );
  }
  return <SelectionMenuText selectable={selectable} {...rest} />;
}

/**
 * iOS 可选中块里的嵌套 span:必须也是 UITextView(经库内祖先上下文渲染为原生 child),
 * 混入 RN Text 会破坏原生文本树。仅由 renderInline 在「块可选中且 iOS」时使用。
 */
export function MarkdownSelectableSpan(props: ComponentProps<typeof Text>) {
  const cancelShareSelectionRowTap = useCancelShareSelectionRowTap();
  const handlePress = props.onPress
    ? (event: GestureResponderEvent) => {
      cancelShareSelectionRowTap?.();
      props.onPress?.(event);
    }
    : undefined;
  return (
    <UITextView
      maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
      {...props}
      onPress={handlePress}
    />
  );
}
