import { Lexer, type Token, type Tokens } from 'marked';

import { htmlImgToImageNode } from './htmlImage';

/** Extract display text without generating HTML or counting link destinations. */
export function markdownPreviewText(markdown: string): string {
  return previewTokens(Lexer.lex(markdown, { gfm: true }))
    .replace(/\s+/g, ' ')
    .trim();
}

function previewTokens(tokens: Token[]): string {
  return tokens
    .map((token): string => {
      switch (token.type) {
        case 'space':
        case 'br':
        case 'hr':
        case 'def':
          return ' ';
        case 'html':
          return `${htmlImgToImageNode({ type: 'html', value: token.text })?.alt ?? ''} `;
        case 'list':
          return `${token.items.map((item: Tokens.ListItem) => previewTokens(item.tokens)).join(' ')} `;
        case 'table':
          return (
            [token.header, ...token.rows]
              .map((row: { tokens: Token[] }[]) =>
                row.map((cell) => previewTokens(cell.tokens)).join(' '),
              )
              .join(' ') + ' '
          );
        case 'heading':
        case 'paragraph':
        case 'blockquote':
          return `${previewTokens(token.tokens ?? [])} `;
        case 'code':
          return `${token.text} `;
        default:
          if ('tokens' in token && token.tokens) return previewTokens(token.tokens);
          return 'text' in token ? token.text : '';
      }
    })
    .join('');
}
