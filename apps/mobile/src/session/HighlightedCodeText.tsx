import { useMemo } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Text } from '@/components/AppText';
import { MarkdownSelectableText } from './MarkdownSelectableText';
import { syntaxColorKey, tokenizeCode } from './codeHighlight';

type HighlightedCodeStyles = Record<
  'markdownCodeText' | 'syntaxKeyword' | 'syntaxString' | 'syntaxComment' | 'syntaxNumber' | 'syntaxFunction' | 'syntaxProperty',
  StyleProp<TextStyle>
>;

/** iOS 可选中代码的子 span 必须同属 UITextView，否则对应字符会消失。 */
export function HighlightedCodeText({
  SpanComponent,
  allowIosUITextView,
  language,
  selectable,
  styles,
  text,
}: {
  SpanComponent: typeof Text;
  allowIosUITextView: boolean;
  language: string | undefined;
  selectable: boolean;
  styles: HighlightedCodeStyles;
  text: string;
}) {
  const tokens = useMemo(() => tokenizeCode(text, language), [language, text]);
  return (
    <MarkdownSelectableText
      allowIosUITextView={allowIosUITextView}
      selectable={selectable}
      style={styles.markdownCodeText}
    >
      {tokens.map((token, index) =>
        token.kind === 'plain' ? token.text : (
          <SpanComponent key={index} style={styles[syntaxColorKey[token.kind]]}>
            {token.text}
          </SpanComponent>
        ),
      )}
    </MarkdownSelectableText>
  );
}
