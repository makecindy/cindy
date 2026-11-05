import { useMemo } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Text } from '@/components/AppText';
import { MarkdownSelectableText } from './MarkdownSelectableText';
import { tokenizeCode, type CodeTokenKind } from './codeHighlight';

type HighlightedCodeStyles = Record<
  'markdownCodeText' | 'syntaxKeyword' | 'syntaxString' | 'syntaxComment' | 'syntaxNumber' | 'syntaxFunction' | 'syntaxProperty',
  StyleProp<TextStyle>
>;

function syntaxStyleFor(
  styles: HighlightedCodeStyles,
  kind: Exclude<CodeTokenKind, 'plain'>,
): StyleProp<TextStyle> {
  switch (kind) {
    case 'keyword': return styles.syntaxKeyword;
    case 'string': return styles.syntaxString;
    case 'comment': return styles.syntaxComment;
    case 'number': return styles.syntaxNumber;
    case 'function': return styles.syntaxFunction;
    case 'property': return styles.syntaxProperty;
  }
}

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
          <SpanComponent key={index} style={syntaxStyleFor(styles, token.kind)}>
            {token.text}
          </SpanComponent>
        ),
      )}
    </MarkdownSelectableText>
  );
}
